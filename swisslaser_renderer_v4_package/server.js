'use strict';

const express = require('express');
const sharp = require('sharp');

const app = express();
const PORT = Number(process.env.PORT || 8787);

app.use(express.json({ limit: '50mb' }));

const LOCKED = {
  width: 1080,
  height: 1350,
  footerHeight: 154,
  fonts: {
    heading: 'Poppins',
    body: 'Poppins',
    meta: 'Poppins',
    quotes: 'DejaVu Serif',
  },
};

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

    if (!current || candidate.length <= maxCharsPerLine) {
      current = candidate;
      continue;
    }

    lines.push(current);
    current = word;
  }

  if (current) {
    lines.push(current);
  }

  return lines;
}

function getReviewLayout(review, variant) {
  const length = clean(review).length;
  const isDark = variant === 'dark';

  let fontSize = isDark ? 38 : 37;
  let lineHeight = isDark ? 81 : 69;
  let maxChars = isDark ? 34 : 29;
  const maxLines = isDark ? 5 : 6;

  if (length > 130) {
    fontSize -= 3;
    lineHeight -= isDark ? 8 : 7;
    maxChars += 3;
  }

  if (length > 175) {
    fontSize -= 3;
    lineHeight -= isDark ? 7 : 6;
    maxChars += 4;
  }

  let lines = wrapText(review, maxChars);

  while (lines.length > maxLines && fontSize > 27) {
    fontSize -= 1;
    lineHeight -= 2;
    maxChars += 2;
    lines = wrapText(review, maxChars);
  }

  if (lines.length > 7) {
    throw new Error(
      'review_quote cannot fit the locked testimonial layout.'
    );
  }

  return {
    fontSize,
    lineHeight,
    lines,
  };
}

async function fetchBuffer(url) {
  const value = clean(url);

  if (!value) {
    throw new Error('template_url is required.');
  }

  const response = await fetch(value, {
    headers: {
      'User-Agent': 'SwissLaserRenderer/5.1',
      Accept: 'image/*',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Template download failed with HTTP ${response.status}.`
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function assertUsefulTransparency(buffer) {
  const image = sharp(buffer)
    .rotate()
    .ensureAlpha();

  const { data, info } = await image
    .raw()
    .toBuffer({ resolveWithObject: true });

  const alphaIndex = info.channels - 1;

  let transparentSamples = 0;
  let totalSamples = 0;

  const step = Math.max(
    1,
    Math.floor(
      Math.min(info.width, info.height) / 220
    )
  );

  for (let y = 0; y < info.height; y += step) {
    for (let x = 0; x < info.width; x += step) {
      const offset =
        (y * info.width + x) * info.channels;

      const alpha = data[offset + alphaIndex];

      if (alpha < 245) {
        transparentSamples += 1;
      }

      totalSamples += 1;
    }
  }

  const transparentRatio = totalSamples
    ? transparentSamples / totalSamples
    : 0;

  if (transparentRatio < 0.05) {
    throw new Error(
      'The generated hero image is not genuinely transparent. ' +
      'Set the OpenAI image node to Background: Transparent ' +
      'and Output Format: PNG.'
    );
  }
}

async function prepareSubject(
  heroBuffer,
  width,
  heroHeight,
  variant,
  requestedLayout = {}
) {
  await assertUsefulTransparency(heroBuffer);

  const isDark = variant === 'dark';

  const defaults = isDark
    ? {
        maxWidth: 820,
        maxHeight: 1150,
        left: 325,
        top: 25,
      }
    : {
        maxWidth: 760,
        maxHeight: 1140,
        left: 465,
        top: 70,
      };

  const maxWidth = clamp(
    Math.round(
      numberValue(
        requestedLayout.max_width,
        defaults.maxWidth
      )
    ),
    420,
    width
  );

  const maxHeight = clamp(
    Math.round(
      numberValue(
        requestedLayout.max_height,
        defaults.maxHeight
      )
    ),
    650,
    heroHeight
  );

  const requestedLeft = Math.round(
    numberValue(
      requestedLayout.left,
      defaults.left
    )
  );

  const requestedTop = Math.round(
    numberValue(
      requestedLayout.top,
      defaults.top
    )
  );

  /*
   * Remove only genuine transparent padding around the generated subject.
   */
  const trimmed = await sharp(heroBuffer)
    .rotate()
    .ensureAlpha()
    .trim({
      background: {
        r: 0,
        g: 0,
        b: 0,
        alpha: 0,
      },
      threshold: 8,
    })
    .png()
    .toBuffer();

  /*
   * Resize the visible subject itself rather than putting it inside a
   * large bottom-aligned transparent box.
   */
  const resizedSubject = await sharp(trimmed)
    .resize({
      width: maxWidth,
      height: maxHeight,
      fit: 'inside',
      position: 'center',
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();

  const metadata = await sharp(
    resizedSubject
  ).metadata();

  const subjectWidth =
    Number(metadata.width) || maxWidth;

  const subjectHeight =
    Number(metadata.height) || maxHeight;

  /*
   * Permit deliberate right-edge or top-edge overflow while cropping it
   * safely to the usable area above the permanent footer.
   */
  const sourceLeft = Math.max(
    0,
    -requestedLeft
  );

  const sourceTop = Math.max(
    0,
    -requestedTop
  );

  const destinationLeft = Math.max(
    0,
    requestedLeft
  );

  const destinationTop = Math.max(
    0,
    requestedTop
  );

  const visibleWidth = Math.floor(
    Math.min(
      subjectWidth - sourceLeft,
      width - destinationLeft
    )
  );

  const visibleHeight = Math.floor(
    Math.min(
      subjectHeight - sourceTop,
      heroHeight - destinationTop
    )
  );

  if (
    visibleWidth <= 0 ||
    visibleHeight <= 0
  ) {
    throw new Error(
      'The configured subject position places the treatment subject outside the canvas.'
    );
  }

  let visibleSubject = resizedSubject;

  if (
    sourceLeft > 0 ||
    sourceTop > 0 ||
    visibleWidth < subjectWidth ||
    visibleHeight < subjectHeight
  ) {
    visibleSubject = await sharp(
      resizedSubject
    )
      .extract({
        left: sourceLeft,
        top: sourceTop,
        width: visibleWidth,
        height: visibleHeight,
      })
      .png()
      .toBuffer();
  }

  /*
   * Build one transparent stage matching the full usable hero area.
   * This makes the placement deterministic for every generation.
   */
  const subjectStage = await sharp({
    create: {
      width,
      height: heroHeight,
      channels: 4,
      background: {
        r: 0,
        g: 0,
        b: 0,
        alpha: 0,
      },
    },
  })
    .composite([
      {
        input: visibleSubject,
        left: destinationLeft,
        top: destinationTop,
      },
    ])
    .png()
    .toBuffer();

  return {
    buffer: subjectStage,
    left: 0,
    top: 0,
  };
}

function buildTextSvg({
  width,
  heroHeight,
  variant,
  heading,
  serviceName,
  reviewQuote,
  reviewerName,
}) {
  const isDark = variant === 'dark';

  const textColour = isDark
    ? '#F7F7F5'
    : '#0D0D0D';

  const secondaryColour = isDark
    ? '#F4F4F2'
    : '#171717';

  const quoteColour = isDark
    ? '#BDBDBD'
    : '#C7C7C7';

  const layout = getReviewLayout(
    reviewQuote,
    variant
  );

  /*
   * The light and dark references have intentionally
   * different vertical compositions.
   */
  const settings = isDark
    ? {
        headingX: 58,
        headingY: 185,
        headingSize: 60,

        serviceX: 66,
        serviceY: 258,
        serviceSize: 39,

        topRuleX1: 282,
        topRuleX2: 420,
        topRuleY: 428,

        openingQuoteX: 28,
        openingQuoteY: 650,
        openingQuoteSize: 126,

        bodyX: 82,
        bodyStartY: 735,

        closingQuoteX: 585,

        reviewerInline: true,
      }
    : {
        headingX: 58,
        headingY: 345,
        headingSize: 59,

        serviceX: 62,
        serviceY: 410,
        serviceSize: 39,

        openingQuoteX: 46,
        openingQuoteY: 530,
        openingQuoteSize: 124,

        bodyX: 64,
        bodyStartY: 610,

        closingQuoteX: 405,

        reviewerInline: false,
      };

  const lineMarkup = layout.lines
    .map((line, index) => {
      const y =
        settings.bodyStartY +
        index * layout.lineHeight;

      return `
        <text
          x="${settings.bodyX}"
          y="${y}"
          font-family="${LOCKED.fonts.body}"
          font-size="${layout.fontSize}"
          font-style="italic"
          font-weight="300"
          letter-spacing="-0.25"
          fill="${textColour}"
        >${escapeXml(line)}</text>
      `;
    })
    .join('');

  const lastLineY =
    settings.bodyStartY +
    Math.max(0, layout.lines.length - 1) *
      layout.lineHeight;

  const closingQuoteY = isDark
    ? Math.min(
        lastLineY + 92,
        heroHeight - 120
      )
    : Math.min(
        lastLineY + 94,
        heroHeight - 165
      );

  const lightDividerY = Math.min(
    lastLineY + 132,
    heroHeight - 116
  );

  const lightReviewerY = Math.min(
    lastLineY + 195,
    heroHeight - 64
  );

  const darkReviewerY = Math.min(
    lastLineY + 104,
    heroHeight - 72
  );

  const darkTopRule = isDark
    ? `
      <line
        x1="${settings.topRuleX1}"
        y1="${settings.topRuleY}"
        x2="${settings.topRuleX2}"
        y2="${settings.topRuleY}"
        stroke="#E1E1E1"
        stroke-width="1.5"
      />
    `
    : '';

  const reviewerMarkup =
    settings.reviewerInline
      ? `
        <line
          x1="347"
          y1="${darkReviewerY - 7}"
          x2="378"
          y2="${darkReviewerY - 7}"
          stroke="${textColour}"
          stroke-width="1.5"
        />

        <text
          x="390"
          y="${darkReviewerY}"
          font-family="${LOCKED.fonts.meta}"
          font-size="26"
          font-style="italic"
          font-weight="300"
          fill="${textColour}"
        >${escapeXml(reviewerName)}</text>
      `
      : `
        <line
          x1="61"
          y1="${lightDividerY}"
          x2="114"
          y2="${lightDividerY}"
          stroke="${textColour}"
          stroke-width="1.6"
        />

        <text
          x="61"
          y="${lightReviewerY}"
          font-family="${LOCKED.fonts.meta}"
          font-size="27"
          font-weight="300"
          fill="${textColour}"
        >${escapeXml(reviewerName)}</text>
      `;

  /*
   * There is intentionally no background rectangle.
   * The template and treatment subject remain visible.
   */
  return Buffer.from(`
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${width}"
      height="${heroHeight}"
      viewBox="0 0 ${width} ${heroHeight}"
    >
      <text
        x="${settings.headingX}"
        y="${settings.headingY}"
        font-family="${LOCKED.fonts.heading}"
        font-size="${settings.headingSize}"
        font-weight="600"
        letter-spacing="-1.1"
        fill="${textColour}"
      >${escapeXml(heading)}</text>

      <text
        x="${settings.serviceX}"
        y="${settings.serviceY}"
        font-family="${LOCKED.fonts.meta}"
        font-size="${settings.serviceSize}"
        font-weight="300"
        letter-spacing="-0.35"
        fill="${secondaryColour}"
      >${escapeXml(serviceName)}</text>

      ${darkTopRule}

      <text
        x="${settings.openingQuoteX}"
        y="${settings.openingQuoteY}"
        font-family="${LOCKED.fonts.quotes}, Georgia, serif"
        font-size="${settings.openingQuoteSize}"
        font-weight="700"
        fill="${quoteColour}"
      >“</text>

      ${lineMarkup}

      <text
        x="${settings.closingQuoteX}"
        y="${closingQuoteY}"
        font-family="${LOCKED.fonts.quotes}, Georgia, serif"
        font-size="106"
        font-weight="700"
        fill="${quoteColour}"
      >”</text>

      ${reviewerMarkup}
    </svg>
  `);
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'swisslaser-renderer',
    version: '5.1.0',
    typography: 'Poppins locked',
    templates: 'full-image locked',
  });
});

app.post('/render-review', async (req, res) => {
  try {
    const payload = req.body || {};
    const canvas = payload.canvas || {};

    const width = clamp(
      Math.round(
        numberValue(
          canvas.width,
          LOCKED.width
        )
      ),
      600,
      2160
    );

    const height = clamp(
      Math.round(
        numberValue(
          canvas.height,
          LOCKED.height
        )
      ),
      750,
      2700
    );

    const footerHeight = clamp(
      Math.round(
        numberValue(
          payload.footer_height,
          LOCKED.footerHeight
        )
      ),
      100,
      Math.round(height * 0.18)
    );

    const heroHeight =
      height - footerHeight;

    const variant =
      clean(payload.template_variant)
        .toLowerCase() === 'dark'
        ? 'dark'
        : 'light';

    const reviewQuote = clean(
      payload.review_quote
    );

    if (!reviewQuote) {
      throw new Error(
        'review_quote is required.'
      );
    }

    if (reviewQuote.length > 220) {
      throw new Error(
        'review_quote exceeds the locked ' +
        '220 character layout limit.'
      );
    }

    const heroBase64 = stripDataUri(
      payload.hero_image_base64
    );

    if (!heroBase64) {
      throw new Error(
        'hero_image_base64 is required.'
      );
    }

    const heroBuffer = Buffer.from(
      heroBase64,
      'base64'
    );

    if (!heroBuffer.length) {
      throw new Error(
        'Decoded hero image was empty.'
      );
    }

    /*
     * Use the complete uploaded template:
     * background, footer, official logo and numbers.
     */
    const templateBuffer = await fetchBuffer(
      payload.template_url
    );

    const baseTemplate = await sharp(
      templateBuffer
    )
      .rotate()
      .resize({
        width,
        height,
        fit: 'fill',
      })
      .png()
      .toBuffer();

    const subject = await prepareSubject(
      heroBuffer,
      width,
      heroHeight,
      variant,
      payload.subject_layout || {}
    );

    const textOverlay = buildTextSvg({
      width,
      heroHeight,
      variant,

      heading:
        clean(payload.heading) ||
        'TESTIMONIALS',

      serviceName:
        clean(payload.service_name) ||
        'LASER HAIR REMOVAL',

      reviewQuote,

      reviewerName:
        clean(payload.reviewer_name) ||
        'Client',
    });

    /*
     * Layer order:
     * 1. Permanent GitHub template.
     * 2. Transparent treatment subject.
     * 3. Exact Poppins typography.
     *
     * The footer is already part of the template.
     */
    const finalPng = await sharp(
      baseTemplate
    )
      .composite([
        {
          input: subject.buffer,
          left: subject.left,
          top: subject.top,
        },
        {
          input: textOverlay,
          left: 0,
          top: 0,
        },
      ])
      .png({
        compressionLevel: 9,
        adaptiveFiltering: true,
      })
      .toBuffer();

    const filename =
      clean(payload.output_filename) ||
      'swisslaser_review.png';

    res.setHeader(
      'Content-Type',
      'image/png'
    );

    res.setHeader(
      'Content-Disposition',
      `inline; filename="${filename.replace(
        /"/g,
        ''
      )}"`
    );

    res.setHeader(
      'Content-Length',
      String(finalPng.length)
    );

    res.send(finalPng);
  } catch (error) {
    console.error(error);

    res.status(400).json({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
});

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `SwissLaser renderer v5.1 listening on port ${PORT}`
    );
  }
);
