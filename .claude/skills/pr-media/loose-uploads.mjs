import path from 'node:path';

const LOOSE_IMAGE_TAG_PATTERN = /<img\b[^>]*\balt="([^"]*)"[^>]*\bsrc="(https:\/\/[^"]*user-attachments[^"]*)"[^>]*>/g;
const LOOSE_IMAGE_MARKDOWN_PATTERN = /!\[([^\]]*)\]\((https:\/\/[^\s)]*user-attachments[^\s)]*)\)/g;
const LOOSE_BARE_URL_PATTERN = /^[ \t]*(https:\/\/\S*user-attachments\S*)[ \t]*$/gm;

function stripAnchorPairs(body) {
  return body.replace(/<!-- pr-media: (.+?) -->[\s\S]*?<!-- \/pr-media: \1 -->/g, (pair) => ' '.repeat(pair.length));
}

export function collectLooseUploads(body) {
  const outsideAnchors = stripAnchorPairs(body);
  const uploads = [];
  for (const match of outsideAnchors.matchAll(LOOSE_IMAGE_TAG_PATTERN)) {
    uploads.push({ kind: 'image', alt: match[1], url: match[2], text: match[0], at: match.index });
  }
  for (const match of outsideAnchors.matchAll(LOOSE_IMAGE_MARKDOWN_PATTERN)) {
    uploads.push({ kind: 'image', alt: match[1], url: match[2], text: match[0], at: match.index });
  }
  for (const match of outsideAnchors.matchAll(LOOSE_BARE_URL_PATTERN)) {
    uploads.push({ kind: 'video', alt: '', url: match[1], text: match[0], at: match.index });
  }
  return uploads.sort((a, b) => a.at - b.at);
}

function normalizedStem(text) {
  return path.basename(text, path.extname(text)).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function mapUploadsToFiles(uploads, files) {
  const assets = new Map();
  const unmatchedImages = [];
  const images = files.filter((file) => file.kind === 'image');
  const videos = files.filter((file) => file.kind === 'video');
  for (const upload of uploads.filter((candidate) => candidate.kind === 'image')) {
    const byAlt = images.find((file) => !assets.has(file.name) && normalizedStem(file.name) === normalizedStem(upload.alt));
    if (byAlt) assets.set(byAlt.name, upload.url);
    else unmatchedImages.push(upload);
  }
  for (const upload of unmatchedImages) {
    const next = images.find((file) => !assets.has(file.name));
    if (next) assets.set(next.name, upload.url);
  }
  const videoUploads = uploads.filter((candidate) => candidate.kind === 'video');
  videos.forEach((file, index) => {
    if (videoUploads[index]) assets.set(file.name, videoUploads[index].url);
  });
  const missing = files.filter((file) => !assets.has(file.name)).map((file) => file.name);
  const extra = uploads.filter((upload) => ![...assets.values()].includes(upload.url)).map((upload) => upload.url);
  return { assets, missing, extra };
}
