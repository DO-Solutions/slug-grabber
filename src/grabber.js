const axios = require('axios');

const DO_API_URL = 'https://api.digitalocean.com/v2';

function parseRegions(regionStr) {
  if (!regionStr || typeof regionStr !== 'string') return [];
  return regionStr.split(',').map(r => r.trim()).filter(Boolean);
}

function makeClient(token) {
  return axios.create({
    baseURL: DO_API_URL,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  });
}

async function notifyWebhook(webhookUrl, data) {
  if (!webhookUrl) return false;

  let payload = data;
  if (typeof data === 'object' && data !== null && webhookUrl.includes('hooks.slack.com')) {
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
    await axios.post(webhookUrl, payload);
    return true;
  } catch (error) {
    return false;
  }
}

async function listAllDroplets(client) {
  let allDroplets = [];
  let page = 1;
  let hasMorePages = true;

  while (hasMorePages) {
    try {
      const response = await client.get('/droplets', { params: { page, per_page: 100 } });
      const droplets = response.data.droplets || [];
      allDroplets = [...allDroplets, ...droplets];
      hasMorePages = droplets.length === 100;
      page++;
    } catch (error) {
      hasMorePages = false;
    }
  }

  return allDroplets;
}

async function countExistingDroplets(client, slug, filterRegions) {
  try {
    const allDroplets = await listAllDroplets(client);
    let filtered = allDroplets.filter(d => Array.isArray(d.tags) && d.tags.includes(slug));
    if (filterRegions && filterRegions.length > 0) {
      filtered = filtered.filter(d => d.region && filterRegions.includes(d.region.slug));
    }
    return filtered;
  } catch {
    return [];
  }
}

async function createDroplet(client, { slug, region, image, name, sshKeys }) {
  try {
    const response = await client.post('/droplets', {
      name,
      region,
      size: slug,
      image,
      tags: [slug],
      ssh_keys: sshKeys
    });
    return response.data.droplet;
  } catch (error) {
    return null;
  }
}

/**
 * Main polling function. Accepts a config object and an onLog callback.
 * Returns { created, existing }.
 */
async function checkAndCreateDroplets(config, onLog) {
  const log = onLog || (() => {});
  const { token, slug, regions, image, desiredCount, sshKeys = [], webhookUrl = '', namePrefix } = config;
  const client = makeClient(token);

  if (!regions || regions.length === 0) {
    log('ERROR: At least one region is required.');
    return { created: 0, existing: 0 };
  }

  log(`Checking for ${slug} droplets across regions: ${regions.join(', ')}...`);
  const existingDroplets = await countExistingDroplets(client, slug, regions);
  const totalExisting = existingDroplets.length;
  log(`Found ${totalExisting} existing droplet(s) tagged "${slug}" across listed regions. Desired count: ${desiredCount}`);

  const toCreate = Math.max(0, desiredCount - totalExisting);
  if (toCreate === 0) {
    log(`No new droplets needed. Current count: ${totalExisting}, desired: ${desiredCount}`);
    return { created: 0, existing: totalExisting };
  }

  log(`Need to create ${toCreate} new droplet(s). Trying regions in order: ${regions.join(', ')}...`);
  const allCreatedDroplets = [];
  const prefix = namePrefix || slug;

  const existingPerRegion = {};
  for (const droplet of existingDroplets) {
    const r = droplet.region?.slug;
    if (r) existingPerRegion[r] = (existingPerRegion[r] || 0) + 1;
  }

  let remaining = toCreate;

  for (const region of regions) {
    if (remaining <= 0) break;

    try {
      const regionIndex = existingPerRegion[region] || 0;

      for (let i = 0; i < remaining; i++) {
        const name = `${prefix}-${region}-${regionIndex + i + 1}`;
        log(`Attempting to create droplet "${name}" in ${region}...`);
        const droplet = await createDroplet(client, { name, slug, region, image, sshKeys });

        if (droplet) {
          allCreatedDroplets.push(droplet);
          remaining--;
          log(`Created droplet: ${name} (ID: ${droplet.id}) in ${region}`);

          if (webhookUrl) {
            const sent = await notifyWebhook(webhookUrl, {
              event: 'droplet_created',
              droplet,
              timestamp: new Date().toISOString(),
              configuration: { slug, region, image }
            });
            if (sent) log('Webhook notification sent successfully');
          }
        } else {
          log(`Failed to create droplet in ${region}, trying next region...`);
          break;
        }
      }
    } catch (error) {
      log(`Error in ${region}: ${error.message}. Trying next region...`);
    }
  }

  if (allCreatedDroplets.length > 1 && webhookUrl) {
    await notifyWebhook(webhookUrl, {
      event: 'droplets_created_summary',
      createdCount: allCreatedDroplets.length,
      existingCount: totalExisting,
      dropletIds: allCreatedDroplets.map(d => d.id),
      timestamp: new Date().toISOString(),
      configuration: { slug, region: regions.join(','), image }
    });
  }

  if (allCreatedDroplets.length > 0) {
    log(`Successfully created ${allCreatedDroplets.length} new droplet(s) across regions.`);
  }
  if (remaining > 0) {
    log(`Warning: Could not create ${remaining} droplet(s). All listed regions exhausted.`);
  }

  return { created: allCreatedDroplets.length, existing: totalExisting };
}

module.exports = { parseRegions, checkAndCreateDroplets };
