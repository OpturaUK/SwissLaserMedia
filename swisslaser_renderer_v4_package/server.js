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
      'User-Agent': 'SwissLaserRenderer/5.2',
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

async function inspectSubjectEdges(buffer) {
  const { data, info } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const alphaIndex = info.channels - 1;
  const band = Math.max(
    3,
    Math.round(Math.min(info.width, info.height) * 0.006)
  );

  function alphaAt(x, y) {
    return data[
      (y * info.width + x) * info.channels +
      alphaIndex
    ];
  }

  function verticalRatio(fromX, toX) {
    let opaque = 0;
    let total = 0;

    for (let y = 0; y < info.height; y += 1) {
      for (let x = fromX; x < toX; x += 1) {
        if (alphaAt(x, y) > 24) {
          opaque += 1;
        }
        total += 1;
      }
    }

    return total ? opaque / total : 0;
  }

  function horizontalRatio(fromY, toY) {
    let opaque = 0;
    let total = 0;

    for (let y = fromY; y < toY; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        if (alphaAt(x, y) > 24) {
          opaque += 1;
        }
        total += 1;
      }
    }

    return total ? opaque / total : 0;
  }

  return {
    left: verticalRatio(0, band),
    right: verticalRatio(
      Math.max(0, info.width - band),
      info.width
    ),
    top: horizontalRatio(0, band),
    bottom: horizontalRatio(
      Math.max(0, info.height - band),
      info.height
    ),
  };
}

async function assertSafeSubjectFraming(buffer) {
  const edges = await inspectSubjectEdges(buffer);

  /*
   * The renderer cannot reconstruct anatomy that the image model has
   * already cut off. Reject obvious top/left clipping so an arm or head
   * never enters the final post with a hard rectangular edge.
   *
   * Bottom contact is allowed because the torso can finish cleanly at the
   * footer. A small amount of right-edge contact is also permitted for an
   * editorial crop, but it is logged for visibility.
   */
  if (edges.left > 0.03 || edges.top > 0.03) {
    throw new Error(
      'The generated subject is cropped at the source canvas edge. ' +
      'Regenerate it with the full head and raised arm completely inside ' +
      'the transparent canvas and at least 8% transparent space on the ' +
      'top, left and right sides.'
    );
  }

  if (edges.right > 0.18) {
    console.warn(
      'SwissLaser subject has heavy right-edge contact; ' +
      'the renderer will keep the full available silhouette.'
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
  await assertSafeSubjectFraming(heroBuffer);

  const isDark = variant === 'dark';

  /*
   * The subject is automatically right- and bottom-aligned. This avoids
   * the old artificial right-side box that produced hard arm and waist
   * cut-offs. Legacy left/top payload values are intentionally ignored.
   */
  const defaults = isDark
    ? {
        maxWidth: 760,
        maxHeight: 1140,
        minTop: 24,
        bottomGap: 0,
        rightInset: 0,
        xOffset: 0,
        yOffset: 0,
        paddingX: 18,
        paddingTop: 18,
        paddingBottom: 0,
      }
    : {
        maxWidth: 700,
        maxHeight: 1125,
        minTop: 38,
        bottomGap: 0,
        rightInset: 0,
        xOffset: 0,
        yOffset: 0,
        paddingX: 18,
        paddingTop: 18,
        paddingBottom: 0,
      };

  const minTop = clamp(
    Math.round(
      numberValue(
        requestedLayout.min_top,
        defaults.minTop
      )
    ),
    0,
    Math.max(0, heroHeight - 650)
  );

  const bottomGap = clamp(
    Math.round(
      numberValue(
        requestedLayout.bottom_gap,
        defaults.bottomGap
      )
    ),
    0,
    160
  );

  const rightInset = clamp(
    Math.round(
      numberValue(
        requestedLayout.right_inset,
        defaults.rightInset
      )
    ),
    0,
    180
  );

  const xOffset = clamp(
    Math.round(
      numberValue(
        requestedLayout.x_offset,
        defaults.xOffset
      )
    ),
    -160,
    160
  );

  const yOffset = clamp(
    Math.round(
      numberValue(
        requestedLayout.y_offset,
        defaults.yOffset
      )
    ),
    -120,
    120
  );

  const availableHeight = Math.max(
    650,
    heroHeight - minTop - bottomGap
  );

  const availableWidth = Math.max(
    420,
    width - rightInset
  );

  const maxWidth = clamp(
    Math.round(
      numberValue(
        requestedLayout.max_width,
        defaults.maxWidth
      )
    ),
    420,
    availableWidth
  );

  const maxHeight = clamp(
    Math.round(
      numberValue(
        requestedLayout.max_height,
        defaults.maxHeight
      )
    ),
    650,
    availableHeight
  );

  const paddingX = clamp(
    Math.round(
      numberValue(
        requestedLayout.padding_x,
        defaults.paddingX
      )
    ),
    0,
    80
  );

  const paddingTop = clamp(
    Math.round(
      numberValue(
        requestedLayout.padding_top,
        defaults.paddingTop
      )
    ),
    0,
    80
  );

  const paddingBottom = clamp(
    Math.round(
      numberValue(
        requestedLayout.padding_bottom,
        defaults.paddingBottom
      )
    ),
    0,
    100
  );

  /*
   * Remove only genuine transparent padding, then add back a small,
   * controlled transparent safety margin. This keeps hair, shoulders and
   * the raised arm from looking glued to a rectangular boundary.
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
    .extend({
      top: paddingTop,
      bottom: paddingBottom,
      left: paddingX,
      right: paddingX,
      background: {
        r: 0,
        g: 0,
        b: 0,
        alpha: 0,
      },
    })
    .png()
    .toBuffer();

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
   * Fit the complete cutout inside the full hero canvas. The right edge is
   * aligned naturally, while the bottom of the torso meets the footer so
   * any lower-body crop looks intentional rather than floating mid-frame.
   */
  const destinationLeft = clamp(
    width - rightInset - subjectWidth + xOffset,
    0,
    Math.max(0, width - subjectWidth)
  );

  const destinationTop = clamp(
    heroHeight - bottomGap - subjectHeight + yOffset,
    minTop,
    Math.max(minTop, heroHeight - subjectHeight)
  );

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
        input: resizedSubject,
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
    version: '5.2.0',
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
      `SwissLaser renderer v5.2 listening on port ${PORT}`
    );
  }
);
