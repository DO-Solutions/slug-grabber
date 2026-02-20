const axios = require('axios');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

// Configuration
const DO_API_URL = 'https://api.digitalocean.com/v2';
let DO_API_TOKEN = process.env.DO_API_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const NAME_PREFIX = process.env.NAME_PREFIX || null;

function parseRegions(regionStr) {
  if (!regionStr || typeof regionStr !== 'string') return [];
  return regionStr.split(',').map(r => r.trim()).filter(Boolean);
}

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('slug', {
    type: 'string',
    description: 'Droplet size slug (e.g., gpu-h100x8-640gb)'
  })
  .option('region', {
    type: 'string',
    description: 'Region(s) to deploy Droplets — comma-separated for multiple (e.g., tor1 or tor1,nyc1,sfo3)'
  })
  .option('image', {
    type: 'string',
    description: 'Image to use for the Droplet (e.g., gpu-h100x8-base)'
  })
  .option('desired_count', {
    type: 'number',
    description: 'Desired number of Droplets to maintain'
  })
  .option('ssh_keys', {
    type: 'string',
    description: 'Comma-separated list of SSH key IDs to add to the Droplet'
  })
  .option('webhook_url', {
    type: 'string',
    description: 'Webhook URL to notify when a Droplet is created'
  })
  .demandOption(['slug', 'image', 'desired_count'], 'Please provide all required options')
  .check((argv) => {
    const regionsStr = argv.region || process.env.REGION;
    const parsed = parseRegions(regionsStr);
    if (parsed.length === 0) {
      throw new Error('At least one region is required. Use --region tor1,nyc1 or set REGION=tor1,nyc1');
    }
    return true;
  })
  .help()
  .argv;

// Override webhook URL from command line if provided
const webhookUrl = argv.webhook_url || WEBHOOK_URL;

const regions = parseRegions(argv.region || process.env.REGION);

// Set up Axios instance for DigitalOcean API
const doClient = axios.create({
  baseURL: DO_API_URL,
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${DO_API_TOKEN}`
  }
});

/**
 * Send a notification to the webhook URL
 * @param {Object} data - Data to send to the webhook
 * @returns {Promise<boolean>} - Whether the notification was sent successfully
 */
async function notifyWebhook(data) {
  if (!webhookUrl) {
    return false;
  }

  // Prepare payload – Slack webhooks expect a top-level "text" field
  let payload = data;
  if (typeof data === 'object' && data !== null && webhookUrl.includes('hooks.slack.com')) {
    // Create a concise human-readable message for Slack
    let text = '';
    if (data.event === 'droplet_created' && data.droplet) {
      text = `Droplet created: ${data.droplet.name} (ID: ${data.droplet.id}) in ${data.configuration?.region || 'unknown region'} using ${data.configuration?.slug || 'unknown size'}.`;
    } else if (data.event === 'droplets_created_summary') {
      text = `Created ${data.createdCount} droplets (existing: ${data.existingCount}) for slug ${data.configuration?.slug || 'unknown'} in ${data.configuration?.region || 'unknown region'}. IDs: ${data.dropletIds?.join(', ') || 'n/a'}.`;
    } else {
      text = `Slug Grabber notification:\n\`\`\`\n${JSON.stringify(data, null, 2)}\n\`\`\``;
    }
    payload = { text };
  }

  try {
    console.log(`Sending webhook notification to ${webhookUrl}`);
    await axios.post(webhookUrl, payload);
    console.log('Webhook notification sent successfully');
    return true;
  } catch (error) {
    if (error.response) {
      console.error(
        'Error sending webhook notification:',
        `status=${error.response.status}`,
        'body=',
        JSON.stringify(error.response.data)
      );
    } else {
      console.error('Error sending webhook notification:', error.message);
    }
    return false;
  }
}

/**
 * List all droplets with pagination
 * @returns {Promise<Array>} List of all droplets
 */
async function listAllDroplets() {
  let allDroplets = [];
  let page = 1;
  let hasMorePages = true;

  while (hasMorePages) {
    try {
      const response = await doClient.get('/droplets', {
        params: { page, per_page: 100 }
      });

      const droplets = response.data.droplets || [];
      allDroplets = [...allDroplets, ...droplets];

      // Check if there are more pages
      hasMorePages = droplets.length === 100;
      page++;
    } catch (error) {
      console.error('Error fetching droplets:', error.message);
      hasMorePages = false;
    }
  }

  return allDroplets;
}

/**
 * Count existing droplets of the specified slug, optionally in a specific region
 * @param {string} slug - The droplet size slug to count
 * @param {string} [region] - Optional region slug to filter by (e.g. tor1)
 * @returns {Promise<Array>} - Array of existing droplets with the specified slug (and region)
 */
async function countExistingDroplets(slug, region) {
  try {
    const allDroplets = await listAllDroplets();
    let filtered = allDroplets.filter(droplet => droplet.size_slug === slug);
    if (region) {
      filtered = filtered.filter(droplet => droplet.region && droplet.region.slug === region);
    }
    return filtered;
  } catch (error) {
    console.error('Error counting existing droplets:', error.message);
    return [];
  }
}

/**
 * Create a new Droplet
 * @param {Object} options - Droplet creation options
 * @returns {Promise<Object>} The created droplet
 */
async function createDroplet(options) {
  const { slug, region, image, name, sshKeys } = options;
  
  try {
    const requestBody = {
      name,
      region,
      size: slug,
      image,
      tags: [slug], // Tag with the slug for easier identification
      ssh_keys: sshKeys
    };

    const response = await doClient.post('/droplets', requestBody);
    return response.data.droplet;
  } catch (error) {
    console.error('Error creating droplet:', error.response?.data || error.message);
    return null;
  }
}

/**
 * Check and create droplets if needed (per region)
 */
async function checkAndCreateDroplets() {
  const { slug, image, desired_count, ssh_keys } = argv;
  const sshKeys = ssh_keys ? ssh_keys.split(',').map(key => key.trim()) : [];

  if (regions.length === 0) {
    console.error('At least one region is required (e.g. tor1 or tor1,nyc1,sfo3)');
    return;
  }

  const allCreatedDroplets = [];
  let totalExisting = 0;

  for (const region of regions) {
    try {
      console.log(`Checking for ${slug} droplets in ${region}...`);
      const existingDroplets = await countExistingDroplets(slug, region);
      totalExisting += existingDroplets.length;
      console.log(`Found ${existingDroplets.length} existing ${slug} droplets in ${region}. Desired count: ${desired_count}`);

      const toCreate = Math.max(0, desired_count - existingDroplets.length);
      if (toCreate === 0) {
        console.log(`No new droplets needed in ${region}. Current count: ${existingDroplets.length}, desired: ${desired_count}`);
        continue;
      }

      console.log(`Creating ${toCreate} new ${slug} droplets in ${region}...`);
      const namePrefix = NAME_PREFIX || slug;

      for (let i = 0; i < toCreate; i++) {
        const name = `${namePrefix}-${region}-${existingDroplets.length + i + 1}`;
        const droplet = await createDroplet({
          name,
          slug,
          region,
          image,
          sshKeys
        });

        if (droplet) {
          allCreatedDroplets.push(droplet);
          console.log(`Created droplet: ${name} (ID: ${droplet.id}) in ${region}`);

          if (webhookUrl) {
            await notifyWebhook({
              event: 'droplet_created',
              droplet,
              timestamp: new Date().toISOString(),
              configuration: { slug, region, image }
            });
          }
        }
      }
    } catch (error) {
      console.error(`Error in checkAndCreateDroplets for ${region}:`, error.message);
    }
  }

  if (allCreatedDroplets.length > 1 && webhookUrl) {
    await notifyWebhook({
      event: 'droplets_created_summary',
      createdCount: allCreatedDroplets.length,
      existingCount: totalExisting,
      dropletIds: allCreatedDroplets.map(d => d.id),
      timestamp: new Date().toISOString(),
      configuration: {
        slug,
        region: regions.join(','),
        image
      }
    });
  }
  if (allCreatedDroplets.length > 0) {
    console.log(`Successfully created ${allCreatedDroplets.length} new droplets across regions.`);
  }
}

/**
 * Main function to run the application
 */
async function main() {
  // Verify that the API token is set
  if (!DO_API_TOKEN) {
    console.error('DO_API_TOKEN environment variable is not set');
    process.exit(1);
  }

  console.log('DigitalOcean Slug Grabber Node.js started');
  const namePrefix = NAME_PREFIX || argv.slug;
  if (regions.length === 0) {
    console.error('At least one region is required. Set REGION (e.g. tor1,nyc1) or pass --region tor1,nyc1');
    process.exit(1);
  }
  console.log(`Configuration: slug=${argv.slug}, regions=${regions.join(',')}, image=${argv.image}, desired_count=${argv.desired_count} per region, droplet_name=${namePrefix}-{region}-{index}`);
  
  if (NAME_PREFIX) {
    console.log(`Droplet name prefix: ${NAME_PREFIX}`);
  }
  
  if (webhookUrl) {
    console.log(`Webhook notifications enabled: ${webhookUrl}`);
  } else {
    console.log('Webhook notifications disabled. Set WEBHOOK_URL environment variable or use --webhook_url parameter to enable.');
  }
  
  // Run immediately
  await checkAndCreateDroplets();
  
  // Then check every 30 seconds
  setInterval(checkAndCreateDroplets, 30000);
}

// Start the application
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
}); 