const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { parseRegions, checkAndCreateDroplets } = require('./grabber');

const DO_API_TOKEN = process.env.DO_API_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const NAME_PREFIX = process.env.NAME_PREFIX || null;

const argv = yargs(hideBin(process.argv))
  .option('slug', { type: 'string', description: 'Droplet size slug (e.g., gpu-h100x8-640gb)' })
  .option('region', { type: 'string', description: 'Region(s) — comma-separated (e.g., tor1 or tor1,nyc1,sfo3)' })
  .option('image', { type: 'string', description: 'Image slug (e.g., gpu-h100x8-base)' })
  .option('desired_count', { type: 'number', description: 'Desired number of Droplets' })
  .option('ssh_keys', { type: 'string', description: 'Comma-separated SSH key IDs' })
  .option('webhook_url', { type: 'string', description: 'Webhook URL for notifications' })
  .demandOption(['slug', 'image', 'desired_count'], 'Please provide all required options')
  .check((argv) => {
    const parsed = parseRegions(argv.region || process.env.REGION);
    if (parsed.length === 0) throw new Error('At least one region is required. Use --region tor1,nyc1 or set REGION=tor1,nyc1');
    return true;
  })
  .help()
  .argv;

const regions = parseRegions(argv.region || process.env.REGION);
const webhookUrl = argv.webhook_url || WEBHOOK_URL;

async function main() {
  if (!DO_API_TOKEN) {
    console.error('DO_API_TOKEN environment variable is not set');
    process.exit(1);
  }

  const config = {
    token: DO_API_TOKEN,
    slug: argv.slug,
    regions,
    image: argv.image,
    desiredCount: argv.desired_count,
    sshKeys: argv.ssh_keys ? argv.ssh_keys.split(',').map(k => k.trim()) : [],
    webhookUrl,
    namePrefix: NAME_PREFIX || argv.slug
  };

  console.log('DigitalOcean Slug Grabber Node.js started');
  console.log(`Configuration: slug=${config.slug}, regions=${regions.join(',')}, image=${config.image}, desired_count=${config.desiredCount}, droplet_name=${config.namePrefix}-{region}-{index}`);
  if (webhookUrl) console.log(`Webhook notifications enabled: ${webhookUrl}`);

  await checkAndCreateDroplets(config, console.log);
  setInterval(() => checkAndCreateDroplets(config, console.log), 30000);
}

main().catch(err => { console.error('Fatal error:', err); process.exit(1); });
