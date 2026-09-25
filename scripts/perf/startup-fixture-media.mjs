/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Procedural test images, published through the real artifact authority.
 * No input image, filesystem path or source conversation is accepted or read.
 * User-upload dimensions are synthetic defaults; tool-result images accept
 * anonymous observed dimensions/encoded sizes. AttachmentRef belongs in RuntimeEvent text
 * content.attachments; the PNG bytes stay in the artifact store.
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { isCanonicalArtifactEntityId } from '@maka/core/artifacts';

const GLYPHS = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
};

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer between ${min} and ${max}`);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, checksum]);
}

export function createSyntheticPng({ ordinal, width = 960, height = 600 }) {
  integer(ordinal, 'ordinal', 0, Number.MAX_SAFE_INTEGER);
  integer(width, 'width', 1, 4096);
  integer(height, 'height', 1, 4096);
  if (width * height > 8 * 1024 * 1024) throw new RangeError('Synthetic image exceeds 8 MiPixels');
  // The leading zero in each row is PNG filter 0. Draw directly into scanlines
  // so fixture construction does not allocate and copy a second RGB image.
  const scanlines = Buffer.alloc(height * (width * 3 + 1));
  const rectangle = (left, top, rectangleWidth, rectangleHeight, color) => {
    for (let y = Math.max(0, top); y < Math.min(height, top + rectangleHeight); y++) {
      for (let x = Math.max(0, left); x < Math.min(width, left + rectangleWidth); x++) {
        const at = y * (width * 3 + 1) + 1 + x * 3;
        scanlines[at] = color[0];
        scanlines[at + 1] = color[1];
        scanlines[at + 2] = color[2];
      }
    }
  };
  const text = (value, left, top, scale, color) => {
    for (let index = 0; index < value.length; index++) {
      const glyph = GLYPHS[value[index]];
      if (!glyph) throw new Error('Internal fixture glyph is missing');
      for (let row = 0; row < 7; row++)
        for (let col = 0; col < 5; col++)
          if (glyph[row][col] === '1')
            rectangle(left + (index * 6 + col) * scale, top + row * scale, scale, scale, color);
    }
  };
  const scale = Math.max(1, Math.floor(width / 340));
  const gutter = Math.floor(width / 24);
  const headerHeight = 46 * scale;
  rectangle(0, 0, width, height, [237, 242, 248]);
  rectangle(0, 0, width, headerHeight, [30, 42, 60]);
  text('SYNTHETIC FIXTURE', gutter, 12 * scale, scale, [249, 204, 101]);
  text(`TEST IMAGE ${ordinal}`, gutter, 27 * scale, scale, [226, 234, 244]);
  const sidebarWidth = Math.floor(width * 0.24);
  rectangle(
    gutter,
    headerHeight + gutter,
    sidebarWidth,
    height - headerHeight - 2 * gutter,
    [220, 229, 240],
  );
  for (let row = 0; row < 6; row++) {
    const y =
      headerHeight + 2 * gutter + row * Math.floor((height - headerHeight - 3 * gutter) / 7);
    rectangle(
      gutter * 2,
      y,
      Math.max(10, sidebarWidth - 2 * gutter - ((row + ordinal) % 3) * scale * 9),
      5 * scale,
      [127, 148, 173],
    );
  }
  const contentLeft = sidebarWidth + 2 * gutter;
  const contentWidth = width - contentLeft - gutter;
  for (let card = 0; card < 3; card++) {
    const cardHeight = Math.floor((height - headerHeight - 4 * gutter) / 3);
    const top = headerHeight + gutter + card * (cardHeight + gutter);
    rectangle(contentLeft, top, contentWidth, cardHeight, [255, 255, 255]);
    rectangle(contentLeft + gutter, top + Math.floor(gutter / 2), 12 * scale, 12 * scale, [
      ((ordinal * 13 + card * 31) % 120) + 40,
      143,
      181,
    ]);
    rectangle(
      contentLeft + gutter + 19 * scale,
      top + Math.floor(gutter / 2),
      Math.floor(contentWidth * 0.47),
      5 * scale,
      [85, 110, 143],
    );
    rectangle(
      contentLeft + gutter + 19 * scale,
      top + Math.floor(gutter / 2) + 9 * scale,
      Math.floor(contentWidth * 0.61),
      3 * scale,
      [190, 203, 220],
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // 8-bit RGB, no interlace, filter 0 per row.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk(
      'tEXt',
      Buffer.from(
        `SyntheticFixture\0Procedurally generated test image ${ordinal}; no source pixels.`,
        'ascii',
      ),
    ),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Make an actual encoded image from scratch. Encoder output need not have the
 * source image's entropy: legal ancillary/comment bytes reproduce its stored
 * size, while the report exposes the encoded pixel payload versus padding.
 */
export async function createSyntheticToolImage({ shape, ordinal }) {
  if (!shape || typeof shape !== 'object') throw new TypeError('Expected numeric image shape');
  const safeMimes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!safeMimes.includes(shape.mimeType) || !safeMimes.includes(shape.encodedMimeType))
    throw new TypeError('Image shape must state safe declared and encoded MIME types');
  integer(shape.decodedBytes, 'decodedBytes', 0, 16 * 1024 * 1024);
  integer(shape.base64Chars, 'base64Chars', 0, 24 * 1024 * 1024);
  const width = shape.width ?? 960;
  const height = shape.height ?? 600;
  const png = createSyntheticPng({ ordinal, width, height });
  let encoded = png;
  let actualMimeType = 'image/png';
  let quality;
  if (shape.encodedMimeType === 'image/jpeg') {
    // sharp is already installed in this workspace. Loading it only for JPEG
    // keeps user-upload PNG creation independent of this optional encoder.
    const { default: sharp } = await import('sharp');
    actualMimeType = 'image/jpeg';
    for (const candidate of [75, 30, 1]) {
      encoded = await sharp(png)
        .jpeg({ quality: candidate, chromaSubsampling: '4:2:0' })
        .toBuffer();
      quality = candidate;
      if (
        encoded.length <= shape.decodedBytes &&
        shape.decodedBytes - encoded.length !== 1 &&
        shape.decodedBytes - encoded.length !== 2 &&
        shape.decodedBytes - encoded.length !== 3
      )
        break;
    }
  }
  const encodedPixelPayloadBytes = encoded.length;
  let paddingBytes = 0;
  const wantedPadding = shape.decodedBytes - encoded.length;
  if (actualMimeType === 'image/jpeg' && wantedPadding >= 4) {
    const comments = [];
    let remaining = wantedPadding;
    while (remaining > 0) {
      // JPEG segment length is a uint16 including its own two length bytes;
      // marker+length cost four bytes. Keep every remainder at least four.
      let size = Math.min(remaining, 65537);
      if (remaining - size > 0 && remaining - size < 4) size -= 4 - (remaining - size);
      const comment = Buffer.alloc(size, 0x20);
      comment[0] = 0xff;
      comment[1] = 0xfe;
      comment.writeUInt16BE(size - 2, 2);
      Buffer.from('SYNTHETIC FIXTURE SIZE PADDING', 'ascii').copy(comment, 4, 0, size - 4);
      comments.push(comment);
      remaining -= size;
    }
    encoded = Buffer.concat([encoded.subarray(0, 2), ...comments, encoded.subarray(2)]);
    paddingBytes = wantedPadding;
  } else if (actualMimeType === 'image/png' && wantedPadding >= 12) {
    // Private, ancillary, safe-to-copy chunk before IEND. No source metadata.
    const padding = Buffer.alloc(wantedPadding - 12, 0x20);
    Buffer.from('SYNTHETIC FIXTURE SIZE PADDING', 'ascii').copy(padding);
    encoded = Buffer.concat([
      encoded.subarray(0, -12),
      chunk('fiXt', padding),
      encoded.subarray(-12),
    ]);
    paddingBytes = wantedPadding;
  }
  const data = encoded.toString('base64');
  return {
    block: { type: 'image', mimeType: actualMimeType, data },
    byteAccounting: {
      width,
      height,
      sourceDimensionsKnown: shape.width !== undefined && shape.height !== undefined,
      sourceDeclaredMimeType: shape.mimeType,
      sourceEncodedMimeType: shape.encodedMimeType,
      actualMimeType,
      codecMatched: actualMimeType === shape.encodedMimeType,
      requestedBinaryBytes: shape.decodedBytes,
      actualBinaryBytes: encoded.length,
      binaryDeltaBytes: encoded.length - shape.decodedBytes,
      requestedBase64Chars: shape.base64Chars,
      actualBase64Chars: data.length,
      base64DeltaChars: data.length - shape.base64Chars,
      encodedPixelPayloadBytes,
      paddingBytes,
      paddingMethod:
        actualMimeType === 'image/jpeg' ? 'jpeg-comment-segments' : 'png-private-ancillary-chunk',
      ...(quality === undefined ? {} : { jpegQuality: quality }),
      sha256: createHash('sha256').update(encoded).digest('hex'),
    },
  };
}

export async function createFakeAttachment({
  artifactStore,
  sessionId,
  ordinal,
  width = 960,
  height = 600,
  now = 0,
}) {
  if (!artifactStore || typeof artifactStore.create !== 'function')
    throw new TypeError('Pass the fixture-owned interactive artifact writer');
  if (!isCanonicalArtifactEntityId(sessionId)) throw new TypeError('Invalid synthetic sessionId');
  integer(now, 'now', 0, Number.MAX_SAFE_INTEGER);
  const png = createSyntheticPng({ ordinal, width, height });
  const sha256 = createHash('sha256').update(png).digest('hex');
  const identity = createHash('sha256').update(`${sessionId}\0${ordinal}\0${sha256}`).digest('hex');
  const id = `fixture_img_${identity.slice(0, 40)}`;
  const name = `synthetic-fixture-${ordinal}.png`;
  const record = await artifactStore.create({
    id,
    sessionId,
    turnId: `fixture_upload_${ordinal}`,
    name,
    kind: 'image',
    content: png,
    mimeType: 'image/png',
    source: 'user_upload',
    summary: `sha256:${sha256}`,
    now,
  });
  if (record.id !== id || record.sessionId !== sessionId || record.sizeBytes !== png.length)
    throw new Error('Artifact authority returned unexpected synthetic image identity');
  return {
    attachment: {
      kind: 'image',
      name,
      mimeType: 'image/png',
      bytes: png.length,
      ref: { kind: 'session_file', sessionId, relativePath: record.id },
    },
    artifactId: record.id,
    sha256,
    width,
    height,
    encodedBytes: png.length,
    sourcePixelSizeKnown: false,
    sourceEncodedSizeKnown: false,
  };
}
