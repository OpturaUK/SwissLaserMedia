'use strict';

const express = require('express');
const sharp = require('sharp');

const app = express();
const PORT = Number(process.env.PORT || 8787);

app.use(express.json({ limit: '40mb' }));

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function numberValue(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripDataUri(value) {
  return clean(value).replace(/^data:[^;]+;base64,/i, '');
}

function wrapText(text, maxCharsPerLine) {
  const words = clean(text).split(' ').filter(Boolean);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;

    if (candidate.length <= maxCharsPerLine || !current) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
}

function reviewLayout(review) {
  const length = clean(review).length;

  let fontSize = 39;
  let lineHeight = 63;
  let maxChars = 29;

  if (length > 130) {
    fontSize = 35;
    lineHeight = 56;
    maxChars = 33;
  }

  if (length > 175) {
    fontSize = 31;
    lineHeight = 49;
    maxChars = 38;
  }

  let lines = wrapText(review, maxChars);

  while (lines.length > 7 && fontSize > 27) {
    fontSize -= 2;
    lineHeight -= 3;
    maxChars += 3;
    lines = wrapText(review, maxChars);
  }

  return {
    fontSize,
    lineHeight,
    lines,
  };
}

async function fetchBuffer(url) {
  const value = clean(url);
  if (!value) return null;

  const response = await fetch(value, {
    headers: {
      'User-Agent': 'SwissLaserRenderer/4.0',
      Accept: 'image/*',
    },
  });

  if (!response.ok) {
    throw new Error(`Template download failed with HTTP ${response.status}.`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function detectAndExtractFooter(templateBuffer, canvasWidth, footerHeight) {
  const resized = sharp(templateBuffer).rotate().resize({ width: canvasWidth });
  const { data, info } = await resized
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const sampleStep = 18;
  let footerStart = info.height - 1;
  let foundDarkRun = false;

  for (let y = info.height - 1; y >= 0; y -= 1) {
    let total = 0;
    let samples = 0;

    for (let x = 0; x < info.width; x += sampleStep) {
      const offset = (y * info.width + x) * channels;
      const r = data[offset] || 0;
      const g = data[offset + 1] || 0;
      const b = data[offset + 2] || 0;
      total += (r + g + b) / 3;
      samples += 1;
    }

    const average = samples ? total / samples : 255;
    const isDark = average < 42;

    if (isDark) {
      footerStart = y;
      foundDarkRun = true;
      continue;
    }

    if (foundDarkRun) break;
  }

  let sourceFooterHeight = info.height - footerStart;

  if (!foundDarkRun || sourceFooterHeight < 70 || sourceFooterHeight > info.height * 0.25) {
    sourceFooterHeight = Math.round(info.height * 0.105);
    footerStart = info.height - sourceFooterHeight;
  }

  return sharp(templateBuffer)
    .rotate()
    .resize({ width: canvasWidth })
    .extract({
      left: 0,
      top: footerStart,
      width: canvasWidth,
      height: sourceFooterHeight,
    })
    .resize({
      width: canvasWidth,
      height: footerHeight,
      fit: 'fill',
    })
    .png()
    .toBuffer();
}

function fallbackFooterSvg(width, height) {
  const scale = width / 1080;
  const y = Math.round(height * 0.60);

  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#000000"/>

      <text x="${Math.round(48 * scale)}" y="${y}"
        font-family="DejaVu Sans, Arial, sans-serif"
        font-size="${Math.round(45 * scale)}"
        fill="#ffffff">
        <tspan font-weight="300">SWISS</tspan><tspan font-weight="700">LASER</tspan>
      </text>
      <line x1="${Math.round(49 * scale)}" y1="${Math.round(y + 8 * scale)}"
        x2="${Math.round(368 * scale)}" y2="${Math.round(y + 8 * scale)}"
        stroke="#ffffff" stroke-width="1"/>
      <text x="${Math.round(207 * scale)}" y="${Math.round(y + 29 * scale)}"
        font-family="DejaVu Sans, Arial, sans-serif"
        font-size="${Math.round(16 * scale)}" fill="#ffffff">UNITED KINGDOM</text>

      <line x1="${Math.round(402 * scale)}" y1="${Math.round(35 * scale)}"
        x2="${Math.round(402 * scale)}" y2="${Math.round(height - 31 * scale)}"
        stroke="#ffffff" stroke-width="1"/>

      <text x="${Math.round(442 * scale)}" y="${Math.round(y + 1 * scale)}"
        font-family="DejaVu Sans, Arial, sans-serif"
        font-size="${Math.round(35 * scale)}" font-weight="300" fill="#ffffff">0333 038 6624</text>

      <line x1="${Math.round(720 * scale)}" y1="${Math.round(35 * scale)}"
        x2="${Math.round(720 * scale)}" y2="${Math.round(height - 31 * scale)}"
        stroke="#ffffff" stroke-width="1"/>

      <circle cx="${Math.round(769 * scale)}" cy="${Math.round(y - 10 * scale)}"
        r="${Math.round(18 * scale)}" fill="none" stroke="#ffffff" stroke-width="3"/>
      <path d="M ${Math.round(758 * scale)} ${Math.round(y + 7 * scale)}
        L ${Math.round(761 * scale)} ${Math.round(y - 1 * scale)}"
        stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>

      <text x="${Math.round(802 * scale)}" y="${Math.round(y + 1 * scale)}"
        font-family="DejaVu Sans, Arial, sans-serif"
        font-size="${Math.round(33 * scale)}" font-weight="300" fill="#ffffff">07354 708 976</text>
    </svg>
  `);
}

function buildTextSvg({
  width,
  heroHeight,
  variant,
  heading,
  serviceName,
  reviewQuote,
  reviewerName,
  leftPanelWidth,
  typography = {},
  quoteStyle = {},
  requestedLayout = {},
  panelColour,
}) {
  const isDark = variant === 'dark';
  const textColour = isDark ? '#FFFFFF' : '#111111';
  const secondaryColour = isDark ? '#F1F1F1' : '#111111';
  const quoteColour = clean(quoteStyle.quote_colour) || (isDark ? '#7A7A7A' : '#CFCFCF');
  const fillColour = clean(panelColour) || (isDark ? '#3E3E3E' : '#F8F7F5');

  const headingFamily = clean(typography.family_heading) || 'Liberation Sans, DejaVu Sans, Arial, sans-serif';
  const bodyFamily = clean(typography.family_body) || 'Liberation Sans, DejaVu Sans, Arial, sans-serif';
  const metaFamily = clean(typography.family_meta) || 'Liberation Sans, DejaVu Sans, Arial, sans-serif';

  const headingX = numberValue(requestedLayout.heading_x, 60);
  const headingY = numberValue(requestedLayout.heading_y, 222);
  const serviceX = numberValue(requestedLayout.service_x, 60);
  const serviceY = numberValue(requestedLayout.service_y, 290);
  const openingQuoteX = numberValue(requestedLayout.opening_quote_x, 34);
  const openingQuoteY = numberValue(requestedLayout.opening_quote_y, 470);
  const bodyX = numberValue(requestedLayout.body_x, 62);
  const bodyStartY = numberValue(requestedLayout.body_start_y, 585);
  const reviewerX = numberValue(requestedLayout.reviewer_x, 62);

  const layout = reviewLayout(reviewQuote);
  const lineMarkup = layout.lines.map((line, index) => {
    const y = bodyStartY + index * layout.lineHeight;
    return `<text x="${bodyX}" y="${y}"
      font-family="${escapeXml(bodyFamily)}"
      font-size="${layout.fontSize}"
      font-style="italic"
      font-weight="400"
      fill="${textColour}">${escapeXml(line)}</text>`;
  }).join('');

  const lastLineY = bodyStartY + Math.max(0, layout.lines.length - 1) * layout.lineHeight;
  const closingQuoteY = Math.min(lastLineY + 90, heroHeight - 170);
  const closingQuoteX = Math.min(leftPanelWidth - 80, 405);
  const dividerY = Math.min(lastLineY + 122, heroHeight - 120);
  const reviewerY = Math.min(lastLineY + 171, heroHeight - 68);

  return Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${heroHeight}" viewBox="0 0 ${width} ${heroHeight}">
      <rect x="0" y="0" width="${leftPanelWidth}" height="${heroHeight}" fill="${fillColour}"/>

      <text x="${headingX}" y="${headingY}"
        font-family="${escapeXml(headingFamily)}"
        font-size="62" font-weight="700" fill="${textColour}">${escapeXml(heading)}</text>

      <text x="${serviceX}" y="${serviceY}"
        font-family="${escapeXml(metaFamily)}"
        font-size="38" font-weight="300" letter-spacing="0.4" fill="${secondaryColour}">${escapeXml(serviceName)}</text>

      <text x="${openingQuoteX}" y="${openingQuoteY}"
        font-family="DejaVu Serif, Georgia, serif"
        font-size="132" font-weight="700" fill="${quoteColour}">“</text>

      ${lineMarkup}

      <text x="${closingQuoteX}" y="${closingQuoteY}"
        font-family="DejaVu Serif, Georgia, serif"
        font-size="108" font-weight="700" fill="${quoteColour}">”</text>

      <line x1="${reviewerX}" y1="${dividerY}" x2="${reviewerX + 54}" y2="${dividerY}"
        stroke="${textColour}" stroke-width="2"/>

      <text x="${reviewerX}" y="${reviewerY}"
        font-family="${escapeXml(metaFamily)}"
        font-size="28" font-weight="300" fill="${textColour}">${escapeXml(reviewerName)}</text>
    </svg>
  `);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'swisslaser-renderer', version: '4.0.0' });
});

app.post('/render-review', async (req, res) => {
  try {
    const payload = req.body || {};
    const canvas = payload.canvas || {};

    const width = clamp(Math.round(numberValue(canvas.width, 1080)), 600, 2160);
    const height = clamp(Math.round(numberValue(canvas.height, 1350)), 750, 2700);
    const footerHeight = clamp(
      Math.round(numberValue(payload.footer_height, height * 0.114)),
      100,
      Math.round(height * 0.18),
    );
    const heroHeight = height - footerHeight;
    const variant = clean(payload.template_variant).toLowerCase() === 'dark' ? 'dark' : 'light';
    const background = clean(payload.background_fill) || (variant === 'dark' ? '#3E3E3E' : '#F8F7F5');
    const leftPanelColour = clean(payload.left_panel_fill) || background;
    const leftPanelPercent = clamp(numberValue(payload.hero?.text_zone_percent, 46), 40, 54);
    const leftPanelWidth = Math.round(width * leftPanelPercent / 100);

    const heroBase64 = stripDataUri(payload.hero_image_base64);
    if (!heroBase64) {
      throw new Error('hero_image_base64 is required.');
    }

    const reviewQuote = clean(payload.review_quote);
    if (!reviewQuote) {
      throw new Error('review_quote is required.');
    }

    if (reviewQuote.length > 220) {
      throw new Error('review_quote exceeds the locked 220 character layout limit.');
    }

    const heroBuffer = Buffer.from(heroBase64, 'base64');
    if (!heroBuffer.length) {
      throw new Error('Decoded hero image was empty.');
    }

    const preparedHero = await sharp(heroBuffer)
      .rotate()
      .resize({
        width,
        height: heroHeight,
        fit: clean(payload.hero?.fit) || 'cover',
        position: clean(payload.hero?.position) || 'right center',
        background,
      })
      .flatten({ background })
      .png()
      .toBuffer();

    let footerBuffer;
    try {
      const templateBuffer = await fetchBuffer(payload.template_url);
      footerBuffer = templateBuffer
        ? await detectAndExtractFooter(templateBuffer, width, footerHeight)
        : fallbackFooterSvg(width, footerHeight);
    } catch (error) {
      console.warn('Template footer fallback:', error.message);
      footerBuffer = fallbackFooterSvg(width, footerHeight);
    }

    const textOverlay = buildTextSvg({
      width,
      heroHeight,
      variant,
      heading: clean(payload.heading) || 'TESTIMONIALS',
      serviceName: clean(payload.service_name) || 'LASER HAIR REMOVAL',
      reviewQuote,
      reviewerName: clean(payload.reviewer_name) || 'Client',
      leftPanelWidth,
      typography: payload.typography || {},
      quoteStyle: payload.quote_style || {},
      requestedLayout: payload.layout || {},
      panelColour: leftPanelColour,
    });

    const finalPng = await sharp({
      create: {
        width,
        height,
        channels: 4,
        background,
      },
    })
      .composite([
        { input: preparedHero, left: 0, top: 0 },
        { input: textOverlay, left: 0, top: 0 },
        { input: footerBuffer, left: 0, top: heroHeight },
      ])
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();

    const filename = clean(payload.output_filename) || 'swisslaser_review.png';
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/"/g, '')}"`);
    res.setHeader('Content-Length', String(finalPng.length));
    res.send(finalPng);
  } catch (error) {
    console.error(error);
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SwissLaser renderer listening on port ${PORT}`);
});
