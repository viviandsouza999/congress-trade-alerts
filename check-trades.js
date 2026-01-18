// check-trades.js - Checks for new congressional trades and sends email alerts

const https = require('https');

// Get config from environment variables (set in GitHub Secrets)
const CONFIG = {
  YOUR_EMAIL: process.env.YOUR_EMAIL,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY
};

// Fetch congressional trades from Senate Stock Watcher
async function fetchRecentTrades() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'senate-stock-watcher-data.s3-us-west-2.amazonaws.com',
      path: '/aggregate/all_transactions.json',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    };

    console.log('Fetching from Senate Stock Watcher...');

    https.get(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Get only the most recent 15 trades
          const recent = Array.isArray(parsed) ? parsed.slice(0, 15) : [];
          console.log(`Successfully parsed ${recent.length} trades`);
          resolve(recent);
        } catch (e) {
          console.error('JSON parse error:', e.message);
          console.error('Data preview:', data.substring(0, 200));
          reject(e);
        }
      });
    }).on('error', (err) => {
      console.error('HTTPS request error:', err.message);
      reject(err);
    });
  });
}

// Check if we've seen this trade before in Supabase
async function isNewTrade(tradeId) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_KEY) {
    console.log('Supabase not configured, treating all as new');
    return true;
  }

  return new Promise((resolve) => {
    try {
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
            resolve(true);
          }
        });
      });
      
      req.on('error', () => resolve(true));
      req.end();
    } catch (e) {
      resolve(true);
    }
  });
}

// Mark trade as seen in Supabase
async function markAsSeen(trade) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_KEY) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    try {
      const url = new URL(`${CONFIG.SUPABASE_URL}/rest/v1/seen_trades`);
      
      const postData = JSON.stringify({
        id: trade.transaction_date + '-' + trade.senator + '-' + trade.ticker,
        politician: trade.senator,
        ticker: trade.ticker,
        filed_date: trade.transaction_date
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

      const req = https.request(url, options, () => resolve());
      req.on('error', () => resolve());
      req.write(postData);
      req.end();
    } catch (e) {
      resolve();
    }
  });
}

// Send email alert via Resend
async function sendEmailAlert(trades) {
  if (!CONFIG.RESEND_API_KEY || !CONFIG.YOUR_EMAIL) {
    console.log('Email not configured, skipping email');
    return Promise.resolve();
  }

  const tradesList = trades.slice(0, 10).map(t => 
    `• ${t.senator || t.representative}: ${t.type} ${t.ticker} ($${t.amount || 'Unknown'}) - ${t.transaction_date}`
  ).join('\n');

  const emailBody = `
🚨 New Congressional Stock Trades Filed!

${tradesList}

${trades.length > 10 ? `\n... and ${trades.length - 10} more trades\n` : ''}

View all trades at: https://senatestockwatcher.com/

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
        'Content-Length': Buffer.byteLength(postData)
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
          console.error(`Email failed: ${res.statusCode} - ${data}`);
          reject(new Error(`Email failed: ${res.statusCode}`));
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
  console.log('🔍 Starting Congressional Trade Checker...');
  console.log('Email configured:', !!CONFIG.YOUR_EMAIL);
  console.log('Resend configured:', !!CONFIG.RESEND_API_KEY);
  console.log('Supabase configured:', !!CONFIG.SUPABASE_URL);
  
  try {
    const trades = await fetchRecentTrades();
    
    if (!trades || trades.length === 0) {
      console.log('❌ No trades found');
      return;
    }

    console.log(`✓ Found ${trades.length} recent trades`);
    
    const newTrades = [];
    for (const trade of trades) {
      if (!trade.senator && !trade.representative) continue;
      if (!trade.ticker) continue;
      
      const tradeId = (trade.transaction_date || trade.disclosure_date) + '-' + 
                     (trade.senator || trade.representative) + '-' + trade.ticker;
      
      if (await isNewTrade(tradeId)) {
        newTrades.push(trade);
      }
    }
    
    if (newTrades.length === 0) {
      console.log('✓ No new trades (all previously seen)');
      return;
    }
    
    console.log(`🎯 Found ${newTrades.length} NEW trades!`);
    
    // Show sample
    console.log('Sample:', newTrades[0].senator || newTrades[0].representative, 
                newTrades[0].type, newTrades[0].ticker);
    
    await sendEmailAlert(newTrades);
    
    for (const trade of newTrades) {
      await markAsSeen(trade);
    }
    
    console.log('✓ All done!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    throw error;
  }
}

checkForNewTrades().catch(console.error);
