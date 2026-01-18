import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// ACTIVITY LOGGING
// ============================================
const LOG_FILE = join(__dirname, 'activity.log');

function logActivity(action, details, req) {
  const timestamp = new Date().toISOString();
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';

  const logEntry = JSON.stringify({
    timestamp,
    action,
    ip,
    userAgent,
    ...details
  }) + '\n';

  fs.appendFileSync(LOG_FILE, logEntry);
  console.log(`[LOG] ${action}: ${JSON.stringify(details)}`);
}

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'padsplit-insights-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 3600000 } // 1 hour
}));

// Trust proxy for Railway (to get real IP)
app.set('trust proxy', 1);

// Store active scraping sessions
const scrapingSessions = new Map();

// ============================================
// PADSPLIT SCRAPER FUNCTIONS
// ============================================

async function createBrowserSession() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  return { browser, context };
}

async function loginToPadSplit(page, email, password) {
  console.log(`[LOGIN] Starting login for ${email}...`);
  await page.goto('https://www.padsplit.com/login', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);

  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);

  // Use specific selector to avoid matching header "Sign in" text
  await page.click('button:has-text("Sign in"):not(:has-text("Google")):not(:has-text("Facebook")):not(:has-text("Apple"))');
  await page.waitForTimeout(5000);

  // Check if login succeeded by verifying we're not still on login page
  const currentUrl = page.url();
  console.log(`[LOGIN] After login, URL is: ${currentUrl}`);

  if (currentUrl.includes('/login')) {
    const content = await page.textContent('body');
    if (content.includes('Invalid') || content.includes('incorrect')) {
      throw new Error('Invalid credentials');
    }
    throw new Error('Login failed - still on login page');
  }

  console.log(`[LOGIN] Login successful!`);
  return true;
}

async function getAllMetroAreas(page) {
  await page.goto('https://www.padsplit.com/hosts/market-insights', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  const response = await page.evaluate(async () => {
    const res = await fetch('https://www.padsplit.com/api/partner/insights/', { credentials: 'include' });
    return res.json();
  });

  return response;
}

async function getMetroAreaDetails(page, metroId) {
  const response = await page.evaluate(async (id) => {
    const res = await fetch(`https://www.padsplit.com/api/partner/insights/metro_area/${id}/`, { credentials: 'include' });
    return res.json();
  }, metroId);

  return response;
}

async function scrapeZipCode(page, zipCode) {
  const url = `https://www.padsplit.com/hosts/market-insights?zip=${zipCode}`;

  console.log(`[SCRAPE] Loading zip ${zipCode}...`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  const fullContent = await page.textContent('body');

  const data = {
    zipCode,
    status: 'active',
    activeUnits: null,
    upcomingUnits: null,
    sharedBathroomPrice: null,
    privateBathroomPrice: null,
    averageOccupancy: null,
    daysToFirstBooking: null,
    daysTo80Booking: null
  };

  // Find the zip-specific section starting with "Postal code XXXXX"
  // This avoids matching city-wide data that appears elsewhere on the page
  const postalCodePattern = new RegExp(`Postal\\s*code\\s*${zipCode}`, 'i');
  const postalMatch = fullContent.match(postalCodePattern);

  let content = fullContent;
  if (postalMatch) {
    // Extract only the section after "Postal code XXXXX" (zip-specific data)
    const startIndex = fullContent.indexOf(postalMatch[0]);
    content = fullContent.substring(startIndex, startIndex + 800);
    console.log(`[SCRAPE] Found zip-specific section for ${zipCode}`);
  } else {
    console.log(`[SCRAPE] WARNING: No "Postal code ${zipCode}" section found - login may have failed`);
    console.log(`[SCRAPE] Page URL: ${page.url()}`);
  }

  // Extract active units
  const activeMatch = content.match(/([\d,]+)\s*active\s*units?/i);
  if (activeMatch) {
    data.activeUnits = parseInt(activeMatch[1].replace(/,/g, ''));
  }

  // Extract upcoming units
  const upcomingMatch = content.match(/([\d,]+)\s*upcoming\s*units?/i);
  if (upcomingMatch) {
    data.upcomingUnits = parseInt(upcomingMatch[1].replace(/,/g, ''));
  }

  // Extract shared bathroom price - look for "XXX per week with a shared bathroom"
  // Note: $ sign may not always be present or may be a special character
  const sharedMatch = content.match(/([\d,]+)\s*per\s*week\s*with\s*a\s*shared\s*bath/i);
  if (sharedMatch) {
    data.sharedBathroomPrice = parseInt(sharedMatch[1].replace(/,/g, ''));
  }

  // Extract private bathroom price - look for "XXX per week with a private bathroom"
  const privateMatch = content.match(/([\d,]+)\s*per\s*week\s*with\s*a\s*private\s*bath/i);
  if (privateMatch) {
    data.privateBathroomPrice = parseInt(privateMatch[1].replace(/,/g, ''));
  }

  // Extract occupancy - "XX% average occupancy"
  const occupancyMatch = content.match(/(\d+)%\s*average\s*occupancy/i);
  if (occupancyMatch) {
    data.averageOccupancy = parseInt(occupancyMatch[1]);
  }

  // Extract days to first booking - "XX days to first booking"
  const firstBookingMatch = content.match(/(\d+)\s*days?\s*to\s*first\s*booking/i);
  if (firstBookingMatch) {
    data.daysToFirstBooking = parseInt(firstBookingMatch[1]);
  }

  // Extract days to 80% booking - "XX days to 80% booking"
  const fullBookingMatch = content.match(/(\d+)\s*days?\s*to\s*80%\s*booking/i);
  if (fullBookingMatch) {
    data.daysTo80Booking = parseInt(fullBookingMatch[1]);
  }

  // Check if no data available
  if (data.activeUnits === null && data.upcomingUnits === null) {
    // Check for specific "no data" indicators
    if (content.includes('no active homes') || content.includes('not have any active')) {
      data.status = 'no_data';
    } else if (data.activeUnits === 0 || content.match(/0\s*active\s*units?/i)) {
      data.status = 'no_active';
      data.activeUnits = 0;
    }
  }

  return data;
}

// ============================================
// API ROUTES
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// View activity log (protected with simple key)
app.get('/api/activity-log', (req, res) => {
  const adminKey = req.query.key;
  if (adminKey !== (process.env.ADMIN_KEY || 'padsplit-admin-2024')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    if (!fs.existsSync(LOG_FILE)) {
      return res.json({ logs: [], message: 'No activity yet' });
    }

    const logContent = fs.readFileSync(LOG_FILE, 'utf-8');
    const logs = logContent.trim().split('\n').filter(Boolean).map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });

    res.json({
      totalEntries: logs.length,
      logs: logs.reverse() // Most recent first
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login to PadSplit
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  let browser, context, page;

  try {
    const session = await createBrowserSession();
    browser = session.browser;
    context = session.context;
    page = await context.newPage();

    await loginToPadSplit(page, email, password);

    // Get metro areas to verify login worked
    const metroAreas = await getAllMetroAreas(page);

    // Store session info
    req.session.loggedIn = true;
    req.session.email = email;
    req.session.password = password; // Note: In production, handle more securely

    // Format cities for frontend
    const cities = metroAreas.map(m => ({
      id: m.metro_area?.id,
      name: m.metro_area?.name || 'Unknown',
      slug: m.metro_slug,
      marketType: m.metro_area?.market_type || (m.is_upcoming ? 'upcoming' : 'active'),
      activeProperties: m.active_properties_count || 0,
      supportedZipcodes: m.supported_zipcodes?.length || 0
    })).sort((a, b) => a.name.localeCompare(b.name));

    // Log successful login
    logActivity('LOGIN_SUCCESS', { email }, req);

    res.json({
      success: true,
      message: 'Login successful',
      citiesCount: cities.length,
      cities
    });

  } catch (error) {
    // Log failed login attempt
    logActivity('LOGIN_FAILED', { email, error: error.message }, req);
    res.status(401).json({ error: error.message || 'Login failed' });
  } finally {
    if (browser) await browser.close();
  }
});

// Get zip codes for a city
app.get('/api/city/:metroId/zipcodes', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { metroId } = req.params;
  let browser, context, page;

  try {
    const session = await createBrowserSession();
    browser = session.browser;
    context = session.context;
    page = await context.newPage();

    await loginToPadSplit(page, req.session.email, req.session.password);

    // Navigate to insights page first
    await page.goto('https://www.padsplit.com/hosts/market-insights', { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const details = await getMetroAreaDetails(page, metroId);

    res.json({
      success: true,
      city: details.name,
      metroId: details.id,
      marketType: details.market_type,
      stats: {
        activeRooms: details.active_rooms_count,
        upcomingRooms: details.upcoming_rooms_count,
        searches: details.searches,
        averageOccupancy: Math.round(details.average_occupancy * 100),
        sharedBathroomPrice: Math.round(details.average_price_shared_bathroom),
        privateBathroomPrice: Math.round(details.average_price_private_bathroom),
        daysToFirstBooking: Math.round(details.days_to_first_booking),
        daysTo80Percent: Math.round(details.days_to_fill_80_percent_occupancy)
      },
      zipCodes: details.zip_codes_list || []
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

// Start scraping selected zip codes
app.post('/api/scrape', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { cityName, zipCodes } = req.body;

  if (!zipCodes || zipCodes.length === 0) {
    return res.status(400).json({ error: 'No zip codes selected' });
  }

  // Create unique scraping session ID
  const sessionId = `scrape_${Date.now()}`;

  // Initialize session state
  scrapingSessions.set(sessionId, {
    status: 'running',
    cityName,
    totalZipCodes: zipCodes.length,
    completedZipCodes: 0,
    currentZipCode: null,
    results: [],
    startTime: Date.now(),
    error: null
  });

  // Start scraping in background
  (async () => {
    let browser, context, page;

    try {
      const session = await createBrowserSession();
      browser = session.browser;
      context = session.context;
      page = await context.newPage();

      await loginToPadSplit(page, req.session.email, req.session.password);

      const scrapeState = scrapingSessions.get(sessionId);

      for (let i = 0; i < zipCodes.length; i++) {
        const zip = zipCodes[i];
        scrapeState.currentZipCode = zip;

        try {
          const data = await scrapeZipCode(page, zip);
          data.city = cityName;
          scrapeState.results.push(data);
        } catch (err) {
          scrapeState.results.push({
            zipCode: zip,
            city: cityName,
            status: 'error',
            error: err.message
          });
        }

        scrapeState.completedZipCodes = i + 1;

        // Small delay between requests
        if (i < zipCodes.length - 1) {
          await page.waitForTimeout(1000);
        }
      }

      scrapeState.status = 'completed';
      scrapeState.endTime = Date.now();

    } catch (error) {
      const scrapeState = scrapingSessions.get(sessionId);
      scrapeState.status = 'error';
      scrapeState.error = error.message;
    } finally {
      if (browser) await browser.close();
    }
  })();

  res.json({
    success: true,
    sessionId,
    message: `Started scraping ${zipCodes.length} zip codes`
  });
});

// Get scraping progress
app.get('/api/scrape/:sessionId/progress', (req, res) => {
  const { sessionId } = req.params;
  const session = scrapingSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    status: session.status,
    totalZipCodes: session.totalZipCodes,
    completedZipCodes: session.completedZipCodes,
    currentZipCode: session.currentZipCode,
    progress: Math.round((session.completedZipCodes / session.totalZipCodes) * 100),
    error: session.error
  });
});

// Get scraping results
app.get('/api/scrape/:sessionId/results', (req, res) => {
  const { sessionId } = req.params;
  const session = scrapingSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    status: session.status,
    cityName: session.cityName,
    results: session.results,
    duration: session.endTime ? session.endTime - session.startTime : null
  });
});

// Export to Excel
app.get('/api/scrape/:sessionId/export', async (req, res) => {
  const { sessionId } = req.params;
  const session = scrapingSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.status !== 'completed') {
    return res.status(400).json({ error: 'Scraping not completed yet' });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'PadSplit Market Insights';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Market Insights');

    // Define columns
    worksheet.columns = [
      { header: 'Zip Code', key: 'zipCode', width: 12 },
      { header: 'City', key: 'city', width: 20 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Active Units', key: 'activeUnits', width: 12 },
      { header: 'Upcoming Units', key: 'upcomingUnits', width: 14 },
      { header: 'Shared Bath $/wk', key: 'sharedBathroomPrice', width: 16 },
      { header: 'Private Bath $/wk', key: 'privateBathroomPrice', width: 16 },
      { header: 'Occupancy %', key: 'averageOccupancy', width: 12 },
      { header: 'Days to 1st Booking', key: 'daysToFirstBooking', width: 18 },
      { header: 'Days to 80%', key: 'daysTo80Booking', width: 14 }
    ];

    // Style header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Add data rows
    session.results.forEach((row, index) => {
      const dataRow = worksheet.addRow({
        zipCode: row.zipCode,
        city: row.city || session.cityName,
        status: row.status === 'active' ? 'Active' : row.status === 'no_data' ? 'No Data' : row.status,
        activeUnits: row.activeUnits,
        upcomingUnits: row.upcomingUnits,
        sharedBathroomPrice: row.sharedBathroomPrice ? `$${row.sharedBathroomPrice}` : '-',
        privateBathroomPrice: row.privateBathroomPrice ? `$${row.privateBathroomPrice}` : '-',
        averageOccupancy: row.averageOccupancy ? `${row.averageOccupancy}%` : '-',
        daysToFirstBooking: row.daysToFirstBooking || '-',
        daysTo80Booking: row.daysTo80Booking || '-'
      });

      // Highlight rows with no data
      if (row.status === 'no_data' || row.status === 'error') {
        dataRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFCE4D6' }
        };
      }
    });

    // Add summary row
    worksheet.addRow({});
    const summaryRow = worksheet.addRow({
      zipCode: 'SUMMARY',
      city: '',
      status: '',
      activeUnits: session.results.reduce((sum, r) => sum + (r.activeUnits || 0), 0),
      upcomingUnits: session.results.reduce((sum, r) => sum + (r.upcomingUnits || 0), 0)
    });
    summaryRow.font = { bold: true };

    // Set response headers
    const filename = `PadSplit_${session.cityName.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true, message: 'Logged out' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║         PadSplit Market Insights Web App                  ║
╠═══════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                 ║
║                                                           ║
║  Open your browser and navigate to the URL above          ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
