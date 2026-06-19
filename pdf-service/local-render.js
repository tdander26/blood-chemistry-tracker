const puppeteer = require('puppeteer-core');
const fs = require('fs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
(async () => {
  const html = fs.readFileSync('/tmp/apex-report-test.html','utf8');
  const footerLabel = 'Baker, Michael';
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args:['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 });
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch(e){}
  const footerTemplate =
    '<div style="width:100%;font-size:7px;font-family:\'IBM Plex Mono\',monospace;color:#8C8378;padding:0 0.75in;display:flex;justify-content:space-between;align-items:center;">' +
    '<span>Momentum Health and Wellness · Functional Analysis Report</span>' +
    '<span>Generated for clinical review · Treatment protocols intentionally omitted</span>' +
    '<span>' + footerLabel + ' · Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>' +
    '</div>';
  await page.pdf({
    path: '/tmp/apex-final.pdf',
    printBackground: true,
    format: 'Letter',
    margin: { top:'0.5in', bottom:'0.6in', left:'0.75in', right:'0.75in' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate,
  });
  await browser.close();
  console.log('wrote /tmp/apex-final.pdf');
})();
