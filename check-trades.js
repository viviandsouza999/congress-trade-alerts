// check-trades.js - Checks for new congressional trades and sends email alerts

const https = require('https');

// Get config from environment variables (set in GitHub Secrets)
const CONFIG = {
  YOUR_EMAIL: process.env.YOUR_EMAIL,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY
};

// Scrape House Stock Watcher (they aggregate congressional trades)
async function fetchRecentTrades() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'house-stock-watcher-data.s3-us-west-2.amazonaws.com',
      path: '/data/all_transactions.json',
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
          // Get only the most recent 20 trades
          const recent = parsed.slice(0, 20);
          resolve(recent);
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
        try {
          const results = JSON.parse(data);
          resolve(results.length === 0);
        } catch (e) {
          // If table doesn't exist yet, treat as new
          resolve(true);
        }
      });
    });
    
    req.on('error', () => resolve(true)); // If error, treat as new
    req.end();
  });
}

// Mark trade as seen in Supabase
async function markAsSeen(trade) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${CONFIG.SUPABASE_URL}/rest/v1/seen_trades`);
    
    const postData = JSON.stringify({
      id: trade.disclosure_date + '-' + trade.representative + '-' + trade.ticker,
      politician: trade.representative,
      ticker: trade.ticker,
      filed_date: trade.disclosure_date
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
    
    req.on('error', () => resolve()); // Continue even if fails
    req.write(postData);
    req.end();
  });
}

// Send email alert via Resend
async function sendEmailAlert(trades) {
  const tradesList = trades.map(t => 
    `• ${t.representative}: ${t.type} ${t.ticker} (${t.amount}) - Filed: ${t.disclosure_date}`
  ).join('\n');

  const emailBody = `
🚨 New Congressional Stock Trades Filed!

${tradesList}

View all trades at: https://housestockwatcher.com/

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
    const trades = await fetchRecentTrades();
    
    console.log(`Found ${trades.length} recent trades`);
    
    const newTrades = [];
    for (const trade of trades) {
      const tradeId = trade.disclosure_date + '-' + trade.representative + '-' + trade.ticker;
      if (await isNewTrade(tradeId)) {
        newTrades.push(trade);
      }
    }
    
    if (newTrades.length === 0) {
      console.log('✓ No new trades');
      return;
    }
    
    console.log(`🎯 Found ${newTrades.length} NEW trades!`);
    
    await sendEmailAlert(newTrades);
    
    for (const trade of newTrades) {
      await markAsSeen(trade);
    }
    
    console.log('✓ All done!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  }
}

checkForNewTrades().catch(console.error);
