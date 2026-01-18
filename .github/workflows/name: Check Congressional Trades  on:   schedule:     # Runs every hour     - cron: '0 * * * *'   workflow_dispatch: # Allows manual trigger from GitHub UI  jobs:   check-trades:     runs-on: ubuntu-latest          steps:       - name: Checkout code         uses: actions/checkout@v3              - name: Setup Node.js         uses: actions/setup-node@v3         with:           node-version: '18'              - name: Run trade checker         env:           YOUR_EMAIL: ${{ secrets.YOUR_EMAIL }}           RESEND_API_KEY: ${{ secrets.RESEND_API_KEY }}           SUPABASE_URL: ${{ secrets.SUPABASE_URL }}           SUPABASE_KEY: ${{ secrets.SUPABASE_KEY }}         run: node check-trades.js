// check-trades.js - Checks for new congressional trades and sends email alerts

const https = require('https');

// CONFIGURATION - Replace these with your actual values
const CONFIG = {
  YOUR_EMAIL: 'your.email@example.com', // Email where you want alerts
  RESEND_API_KEY: 'your_resend_api_key_here', // From resend.com
  SUPABASE_URL: 'your_supabase_url_here', // From supabase.com
  SUPABASE_KEY: 'your_supabase_key_here' // From supabase.com
};

// Fetch congressional trades from Capitol Trades API (free, no key needed)
async function fetchRecentTrades() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.capitoltrades.com',
      path: '/trades?pageSize=20',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Check if we've seen this trade before in Supabase
async function isNewTrade(tradeId) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONFIG.SUPABASE_URL}/rest/v1/seen_trades`);
    url.searchParams.append('id', `eq.${tradeId}`);
    
    const options = {
      method: 'GET',
      headers: {
        'apikey': CONFIG.SUPABASE_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_KEY}`
      }
    };

    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const results = JSON.parse(data);
        resolve(results.length === 0); // New if not found
      });
    });
    
    req.on('error', reject);
    req.end();
  });
}

// Mark trade as seen in Supabase
async function markAsSeen(trade) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONFIG.SUPABASE_URL}/rest/v1/seen_trades`);
    
    const postData = JSON.stringify({
      id: trade.id,
      politician: trade.politician,
      ticker: trade.ticker,
      filed_date: trade.filedDate
    });

    const options = {
      method: 'POST',
      headers: {
        'apikey': CONFIG.SUPABASE_KEY,
        'Authorization': `Bearer ${CONFIG.SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      }
    };

    const req = https.request(url, options, (res) => {
      resolve();
    });
    
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Send email alert via Resend
async function sendEmailAlert(trades) {
  const tradesList = trades.map(t => 
    `• ${t.politician} (${t.party}-${t.chamber}): ${t.type} ${t.ticker} (${t.amount}) - Filed: ${t.filedDate}`
  ).join('\n');

  const emailBody = `
🚨 New Congressional Stock Trades Filed!

${tradesList}

View all trades at: https://www.capitoltrades.com/

---
This is an automated alert from your Congressional Trade Tracker.
  `.trim();

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      from: 'alerts@resend.dev',
      to: CONFIG.YOUR_EMAIL,
      subject: `🚨 ${trades.length} New Congressional Trade${trades.length > 1 ? 's' : ''} Filed`,
      text: emailBody
    });

    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': postData.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('✓ Email sent successfully');
          resolve(data);
        } else {
          reject(new Error(`Email failed: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Main function
async function checkForNewTrades() {
  console.log('🔍 Checking for new trades...');
  
  try {
    // Fetch recent trades
    const response = await fetchRecentTrades();
    const trades = response.data || [];
    
    console.log(`Found ${trades.length} recent trades`);
    
    // Filter to only new trades
    const newTrades = [];
    for (const trade of trades) {
      if (await isNewTrade(trade.id)) {
        newTrades.push(trade);
      }
    }
    
    if (newTrades.length === 0) {
      console.log('✓ No new trades');
      return;
    }
    
    console.log(`🎯 Found ${newTrades.length} NEW trades!`);
    
    // Send email alert
    await sendEmailAlert(newTrades);
    
    // Mark all as seen
    for (const trade of newTrades) {
      await markAsSeen(trade);
    }
    
    console.log('✓ All done!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  }
}

// Run it
checkForNewTrades().catch(console.error);
