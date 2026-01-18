# PadSplit Market Insights

A web app to extract market data from PadSplit for any city and export to Excel.

## Requirements

- **Node.js** (version 18 or higher) - [Download here](https://nodejs.org/)
- **PadSplit Host Account** - [Sign up here](https://www.padsplit.com/hosts)

## Installation

### Step 1: Download the App

Download and extract the `padsplit-webapp.zip` file to a folder on your computer.

Or clone with git:
```bash
git clone <repository-url>
cd webapp
```

### Step 2: Install Dependencies

Open a terminal/command prompt in the app folder and run:

```bash
npm install
```

This will install all required packages (takes 1-2 minutes).

### Step 3: Install Browser Engine

Run this once to download the browser engine:

```bash
npx playwright install chromium
```

This downloads ~170MB for the headless browser.

## Running the App

Start the server:

```bash
npm start
```

You'll see:
```
╔═══════════════════════════════════════════════════════════╗
║         PadSplit Market Insights Web App                  ║
╠═══════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:3000                 ║
╚═══════════════════════════════════════════════════════════╝
```

Open your browser and go to: **http://localhost:3000**

## How to Use

1. **Login** - Enter your PadSplit email and password
2. **Select City** - Choose from 109 available cities
3. **Select Zip Codes** - Pick which zip codes to scrape (or Select All)
4. **Wait** - Scraping takes ~8 seconds per zip code
5. **Download** - Click "Download Excel File" when complete

## Troubleshooting

### "Port 3000 already in use"
Another app is using port 3000. Either:
- Close the other app, or
- Change the port in `server.js` (line: `const PORT = 3000`)

### "Login failed"
- Verify your PadSplit credentials are correct
- Make sure you have a PadSplit **Host** account (not Member)

### "No data" for all zip codes
- Your PadSplit session may have expired
- Try logging out and back in

### Slow performance
- Each zip code takes ~8 seconds (this is normal)
- 92 zip codes = ~12 minutes
- Don't close the browser tab while scraping

## System Requirements

| Resource | Minimum |
|----------|---------|
| RAM | 4 GB |
| Disk Space | 500 MB |
| Internet | Required |
| OS | Windows, Mac, or Linux |

## File Structure

```
webapp/
├── server.js        # Backend server
├── package.json     # Dependencies
└── public/
    └── index.html   # Frontend UI
```

## Support

For issues or questions, contact the developer.
