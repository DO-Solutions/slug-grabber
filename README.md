# DigitalOcean Slug Grabber

A Node.js application that automatically provisions DigitalOcean Droplets when they become available. This application periodically checks for available resources and creates Droplets up to your specified count.

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/DO-Solutions/slug-grabber/tree/main)

- [DigitalOcean Slug Grabber](#digitalocean-slug-grabber)
  - [Cheat Sheet](#cheat-sheet)
  - [Features](#features)
  - [Prerequisites](#prerequisites)
  - [Installation and Usage](#installation-and-usage)
    - [Deploy to DigitalOcean App Platform as a Worker](#deploy-to-digitalocean-app-platform-as-a-worker)
    - [Using Docker](#using-docker)
    - [Using Node.js Directly](#using-nodejs-directly)
  - [Configuration Options](#configuration-options)
  - [Webhook Notifications](#webhook-notifications)
    - [For individual Droplet creation:](#for-individual-droplet-creation)
    - [For multiple Droplets creation summary:](#for-multiple-droplets-creation-summary)
    - [Expected console output](#expected-console-output)
  - [GPU Resources Cheat Sheet](#gpu-resources-cheat-sheet)

## Cheat Sheet

1. Use the Deploy to DO button for a ready-to-go deployment
2. `doctl compute ssh-key list` to get your SSH key IDs
3. For a complete list of all DigitalOcean slugs, see: [slugs.do-api.dev](https://slugs.do-api.dev/)
4. Use Discord, Slack or [Webhook.site](https://webhook.site/) for easy Webhooks

## Features

- **Automatic Provisioning**: Creates Droplets when they become available
- **Configurable Parameters**: Specify Droplet size, region, image, and count
- **Smart Provisioning**: Only creates new Droplets if your desired count isn't reached
- **Docker Support**: Run as a containerized application
- **Webhook Notifications**: Get notified via webhook when Droplets are created

## Prerequisites

- DigitalOcean API Token with write access
- Node.js 22+ (for direct Node.js usage)
- Docker (for container usage)

## Installation and Usage

### Deploy to DigitalOcean App Platform as a Worker

```yaml
spec:
  name: do-slug-grabber
  region: lon
  workers:
  - dockerfile_path: /Dockerfile
    envs:
    - key: DO_API_TOKEN
      scope: RUN_TIME
      type: SECRET
      value: 
    - key: SLUG
      scope: RUN_TIME
      value: s-1vcpu-1gb
    - key: REGION
      scope: RUN_TIME
      value: tor1
    - key: IMAGE
      scope: RUN_TIME
      value: debian-12-x64
    - key: DESIRED_COUNT
      scope: RUN_TIME
      value: "1"
    - key: SSH_KEYS
      scope: RUN_TIME
      value: "<id>" # doctl compute ssh-key list
    - key: WEBHOOK_URL
      scope: RUN_TIME
      value: https://webhook.site/<your-webhook-id>
    git:
      branch: main
      deploy_on_push: true
      repo_clone_url: https://github.com/DO-Solutions/slug-grabber.git
    instance_count: 1
    instance_size_slug: apps-s-1vcpu-0.5gb
    name: slug-grabber
    source_dir: /
```

### Using Docker

<details>

1. Build the Docker image:
   ```bash
   docker build -t do-grabber .
   ```

2. Run the container with your configuration:
   ```bash
   docker run -d \
     -e DO_API_TOKEN="your-do-api-token" \
     -e SLUG="gpu-h100x8-640gb" \
     -e REGION="tor1" \
     -e IMAGE="gpu-h100x8-base" \
     -e DESIRED_COUNT="1" \
     -e SSH_KEYS="123456,789012" \
     -e WEBHOOK_URL="https://your-webhook-url" \
     --name do-h100-grabber \
     do-grabber
   ```

</details>

### Using Node.js Directly

<details>

1. Clone the repository:
   ```bash
   git clone https://github.com/do-solutions/slug-grabber.git
   cd slug-grabber
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run the application with your configuration:
   ```bash
   DO_API_TOKEN="your-do-api-token" WEBHOOK_URL="https://your-webhook-url" npm start -- \
     --slug="gpu-h100x8-640gb" \
     --region="tor1" \
     --image="gpu-h100x8-base" \
     --desired_count=1 \
     --ssh_keys="123456,789012"
   ```

   You can also specify the webhook URL as a command line parameter:
   ```bash
   DO_API_TOKEN="your-do-api-token" npm start -- \
     --slug="gpu-h100x8-640gb" \
     --region="tor1" \
     --image="gpu-h100x8-base" \
     --desired_count=1 \
     --ssh_keys="123456,789012" \
     --webhook_url="https://your-webhook-url"
   ```

</details>

## Configuration Options

| Parameter | Description | Example |
|-----------|-------------|---------|
| `slug` | The size/type of GPU Droplet | `gpu-h100x8-640gb` |
| `region` | The region where Droplets will be created | `tor1` |
| `image` | The OS image to use | `gpu-h100x8-base` |
| `desired_count` | The total number of GPU Droplets you want | `1` |
| `ssh_keys` | Comma-separated list of SSH key IDs to add | `123456,789012` |
| `webhook_url` | URL to send notifications when Droplets are created | `https://hooks.slack.com/services/XXX/YYY/ZZZ` |

## Webhook Notifications

When a Droplet is successfully created, the application will send a webhook notification to the specified URL. The notification is a JSON payload with the following structure:

### For individual Droplet creation:

<details>

```json
{
  "event": "droplet_created",
  "droplet": {
    "id": 123456789,
    "name": "gpu-h100x8-640gb-1",
    "region": "tor1",
    "size_slug": "gpu-h100x8-640gb",
    "image": "gpu-h100x8-base",
    ...
  },
  "timestamp": "2023-11-06T12:34:56.789Z",
  "configuration": {
    "slug": "gpu-h100x8-640gb",
    "region": "tor1",
    "image": "gpu-h100x8-base"
  }
}
```

</details>

### For multiple Droplets creation summary:

<details>

```json
{
  "event": "droplets_created_summary",
  "createdCount": 2,
  "existingCount": 0,
  "dropletIds": [123456789, 987654321],
  "timestamp": "2023-11-06T12:34:56.789Z",
  "configuration": {
    "slug": "gpu-h100x8-640gb",
    "region": "tor1",
    "image": "gpu-h100x8-base"
  }
}
```
</details>

### Expected console output

<details>

```bash
DigitalOcean Slug Grabber started
Configuration: slug=s-1vcpu-1gb, region=tor1, image=debian-12-x64, desired_count=1
Webhook notifications enabled: https://webhook.site/3345c481-c248-4956-9361-335a0d1abcc8
Checking for s-1vcpu-1gb droplets in tor1...
Found 0 existing s-1vcpu-1gb droplets. Desired count: 1
Creating 1 new s-1vcpu-1gb droplets...
Created droplet: s-1vcpu-1gb-1 (ID: 491276154)
Sending webhook notification to https://webhook.site/3345c481-c248-4956-9361-335a0d1abcc8
Webhook notification sent successfully
Successfully created 1 new droplets.
Checking for s-1vcpu-1gb droplets in tor1...
Found 1 existing s-1vcpu-1gb droplets. Desired count: 1
No new droplets needed. Current count: 1, desired: 1
```
</details>

You can use these webhooks to integrate with services like Slack, Discord, or your own applications.

## GPU Resources Cheat Sheet

| GPU Type | Slug | Image | Description |
|----------|------|-------|-------------|
| NVIDIA L40S | `gpu-l40sx1-48gb` | - | 1 L40S GPU, 48GB VRAM |
| NVIDIA H100 | `gpu-h100x1-80gb` | `gpu-h100x1-base` | 1 H100 GPU, 80GB VRAM |
| NVIDIA H100 | `gpu-h100x8-640gb` | `gpu-h100x8-base` | 8 H100 GPUs with NVLink, 640GB total VRAM |

For a complete list of all DigitalOcean slugs, see: [slugs.do-api.dev](https://slugs.do-api.dev/)