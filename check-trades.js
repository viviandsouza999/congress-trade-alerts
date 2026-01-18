// check-trades.js - Checks for new congressional trades and sends email alerts

const https = require('https');

// Get config from environment variables (set in GitHub Secrets)
const CONFIG = {
  YOUR_EMAIL: process.env.YOUR_EMAIL,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY
};

// Fetch from unusual whales congressional trading tracker (free, public)
async function fetchRecentTrades() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.quiverquant.com',
      path: '/congresstrading/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    console.log('Fetching congressional trades...');

    https.get(options, (res) => {
      if (res.statusCode !== 200) {
        console.log(`HTTP ${res.statusCode}, trying alternative...`);
        
        // Try alternative endpoint
        const altOptions = {
          hostname: 'www.capitoltrades.com',
          path: '/trades',
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        };
        
        https.get(altOptions, (altRes) => {
          let data = '';
          altRes.on('data', (chunk) => data += chunk);
          altRes.on('end', () => {
            const trades = parseCapitolTrades(data);
            resolve(trades);
          });
        }).on('error', reject);
        return;
      }

      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const trades = parseQuiverTrades(data);
          console.log(`Parsed ${trades.length} trades from page`);
          resolve(trades);
        } catch (e) {
          console.error('Parse error:', e.message);
          resolve([]);
        }
      });
    }).on('error', reject);
  });
}

// Parse trades from Quiver HTML
function parseQuiverTrades(html) {
  const trades = [];
  const rows = html.match(/<tr[^>]*>.*?<\/tr>/gs) || [];
  
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    if (!row.includes('Representative') && !row.includes('Senator')) continue;
    
    const cells = row.match(/<td[^>]*>(.*?)<\/td>/gs) || [];
    if (cells.length < 5) continue;
    
    const getText = (cell) => cell.replace(/<[^>]*>/g, '').trim();
    
    trades.push({
      politician: getText(cells[0]),
      ticker: getText(cells[1]),
      type: getText(cells[2]),
      amount: getText(cells[3]),
      date: getText(cells[4])
    });
  }
  
  return trades;
}

// Parse trades from Capitol Trades HTML
function parseCapitolTrades(html) {
  const trades = [];
  
  // Look for politician names and tickers
  const patterns = html.match(/data-politician="([^"]*)".*?data-ticker="([^"]*)".*?data-type="([^"]*)"/gs) || [];
  
  for (let i = 0; i < Math.min(patterns.length, 20); i++) {
    const match = patterns[i];
    const politician = (match.match(/data-politician="([^"]*)"/) || [])[1];
    const ticker = (match.match(/data-ticker="([^"]*)"/) || [])[1];
    const type = (match.match(/data-type="([^"]*)"/) || [])[1];
    
    if (politician && ticker) {
      trades.push({
        politician,
        ticker,
        type: type || 'Unknown',
        amount: 'See website',
        date: new Date().toISOString().split('T')[0]
      });
    }
  }
  
  return trades;
}

// Check if we've seen this trade before
async function isNewTrade(tradeId) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_KEY) {
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

// Mark trade as seen
async function markAsSeen(trade) {
  if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_KEY) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    try {
      const url = new URL(`${CONFIG.SUPABASE_URL}/rest/v1/seen_trades`);
      
      const postData = JSON.stringify({
        id: trade.date + '-' + trade.politician + '-' + trade.ticker,
        politician: trade.politician,
        ticker: trade.ticker,
        filed_date: trade.date
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

// Send email alert
async function sendEmailAlert(trades) {
  if (!CONFIG.RESEND_API_KEY || !CONFIG.YOUR_EMAIL) {
    console.log('⚠️  Email not configured');
    console.log('New trades found:', trades.length);
    trades.slice(0, 5).forEach(t => {
      console.log(`  - ${t.politician}: ${t.type} ${t.ticker}`);
    });
    return Promise.resolve();
  }

  const tradesList = trades.slice(0, 10).map(t => 
    `• ${t.politician}: ${t.type} ${t.ticker} (${t.amount})`
  ).join('\n');

  const emailBody = `
🚨 New Congressional Stock Trades!

${tradesList}

${trades.length > 10 ? `... and ${trades.length - 10} more\n` : ''}
View all: https://www.capitoltrades.com/

---
Congressional Trade Tracker
  `.trim();

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      from: 'alerts@resend.dev',
      to: CONFIG.YOUR_EMAIL,
      subject: `🚨 ${trades.length} New Congressional Trade${trades.length > 1 ? 's' : ''}`,
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
          console.log('✓ Email sent!');
          resolve(data);
        } else {
          console.error(`Email failed: ${res.statusCode}`);
          reject(new Error(`Email failed: ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Main
async function checkForNewTrades() {
  console.log('🔍 Congressional Trade Checker Starting...');
  
  try {
    const trades = await fetchRecentTrades();
    
    if (!trades || trades.length === 0) {
      console.log('⚠️  Could not fetch trades (site may be blocking)');
      console.log('💡 Tip: Add YOUR_EMAIL and RESEND_API_KEY secrets for email alerts');
      return;
    }

    console.log(`✓ Found ${trades.length} trades`);
    
    const newTrades = [];
    for (const trade of trades) {
      const tradeId = trade.date + '-' + trade.politician + '-' + trade.ticker;
      if (await isNewTrade(tradeId)) {
        newTrades.push(trade);
      }
    }
    
    if (newTrades.length === 0) {
      console.log('✓ No new trades (all seen before)');
      return;
    }
    
    console.log(`🎯 ${newTrades.length} NEW trades!`);
    
    await sendEmailAlert(newTrades);
    
    for (const trade of newTrades) {
      await markAsSeen(trade);
    }
    
    console.log('✅ Done!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    throw error;
  }
}

checkForNewTrades().catch(console.error);
