const fs = require('fs');
const path = require('path');

const PROVIDERS_PATH = path.join(__dirname, '..', 'config', 'providers.json');

function loadProviders() {
  const raw = fs.readFileSync(PROVIDERS_PATH, 'utf8');
  return JSON.parse(raw);
}

function getProvider(key) {
  const providers = loadProviders();
  return providers[key] || null;
}

module.exports = { loadProviders, getProvider };
