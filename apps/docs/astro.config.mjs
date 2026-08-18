// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

const BASE = '/tendb';

/** Prefix root-relative links in page content with the site base.
 * Content is written with root-relative links (`/reference/cli/`); Starlight
 * only applies the base to its own chrome, not to rendered markdown/MDX. */
function rehypeBaseLinks() {
  /** @param {string} url */
  const withBase = (url) =>
    url.startsWith('/') && !url.startsWith('//') && !url.startsWith(`${BASE}/`)
      ? BASE + url
      : url;
  /** @param {any} node */
  const walk = (node) => {
    if (node.type === 'element' && typeof node.properties?.href === 'string') {
      node.properties.href = withBase(node.properties.href);
    }
    if (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') {
      for (const attr of node.attributes ?? []) {
        if (attr.type === 'mdxJsxAttribute' && attr.name === 'href' && typeof attr.value === 'string') {
          attr.value = withBase(attr.value);
        }
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  return walk;
}

export default defineConfig({
  site: 'https://10play.github.io',
  base: BASE,
  markdown: {
    rehypePlugins: [rehypeBaseLinks],
  },
  integrations: [
    starlight({
      title: 'tendb',
      description:
        'The self-hosted Neon alternative: database branching for Postgres on infrastructure you own — AWS, GCP, Azure, or local Docker. Powered by DBLab Engine.',
      plugins: [
        starlightLlmsTxt({
          projectName: 'tendb',
          description:
            'tendb is a self-hosted Neon replacement: database branching for Postgres, running entirely on infrastructure you own. Each developer and each pull request gets a real, writable copy-on-write branch of your production-shaped Postgres database in seconds, backed by ZFS thin clones via DBLab Engine on a single host — an EC2 instance in your AWS account, a GCP or Azure VM, or Docker on your laptop.',
          details: [
            'Key facts:',
            '',
            '- tendb is self-hosted infrastructure, not a managed service. Data, host, and tunnels stay inside your own cloud account/VPC; the host has no SSH and no inbound internet, and clients connect through each platform\'s native tunnel (SSM on AWS, IAP on GCP, Bastion on Azure, loopback locally).',
            '- It brings the Neon-style branching workflow to any source Postgres — Aurora, RDS, Neon itself, or any `postgres://` URL — by syncing data to the host (nightly dump/restore or logical replication) and serving each branch as a ZFS copy-on-write clone on its own port.',
            '- Install with `npx @10play/tendb init` (scaffolds Terraform + config), then `tendb up`. Day-to-day commands: `tendb branches create <name>`, `tendb psql <name>`, `tendb console`, `tendb ci ensure <pr>`.',
            '- Branches are for development, CI preview databases, and migration rehearsal — not production. There is no autoscaling, PITR, HA, or public endpoint; production keeps running wherever it already runs.',
          ].join('\n'),
          optionalLinks: [
            {
              label: 'GitHub repository',
              url: 'https://github.com/10play/tendb',
              description: 'Source code, issues, and the runnable example app',
            },
            {
              label: 'DBLab Engine',
              url: 'https://github.com/postgres-ai/database-lab-engine',
              description: 'The thin-cloning engine tendb builds on',
            },
            {
              label: '10play',
              url: 'https://10play.dev',
              description: 'The company behind tendb',
            },
          ],
          customSets: [
            {
              label: 'Reference',
              description:
                'Complete reference for the CLI, configuration file, engine contract, snapshot daemon, and Terraform modules',
              paths: ['reference/**'],
            },
            {
              label: 'Getting started',
              description: 'Introduction plus the AWS and local (Docker) quickstarts',
              paths: ['getting-started/**'],
            },
          ],
          promote: ['index*', 'getting-started/**'],
          // Screenshots (theme-duplicated) are noise in plain-text output;
          // keep the figcaptions, drop the image links.
          customSelectors: {
            all: ['img.dark-only', 'img.light-only', '.hero-shot'],
          },
        }),
      ],
      // The console's lockup (10play mark + ten·db, green accent) — the SVG
      // carries the wordmark, so it replaces the text title.
      logo: {
        light: './src/assets/tendb-logo-light.svg',
        dark: './src/assets/tendb-logo-dark.svg',
        alt: 'tendb',
        replacesTitle: true,
      },
      favicon: '/favicon.svg',
      components: {
        Footer: './src/components/Footer.astro',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/10play/tendb' },
        { icon: 'external', label: '10play', href: 'https://10play.dev' },
      ],
      editLink: {
        baseUrl: 'https://github.com/10play/tendb/edit/main/apps/docs/',
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What is tendb?', slug: 'getting-started/introduction' },
            { label: 'AWS quickstart', slug: 'getting-started/quickstart' },
            { label: 'Local quickstart', slug: 'getting-started/local-quickstart' },
          ],
        },
        {
          label: 'How it works',
          items: [
            { label: 'Architecture', slug: 'concepts/architecture' },
            { label: 'Platforms', slug: 'concepts/platforms' },
            { label: 'Security model', slug: 'concepts/security' },
            { label: 'Data refresh lifecycle', slug: 'concepts/data-refresh' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'CI preview environments', slug: 'guides/ci-previews' },
            { label: 'The web console', slug: 'guides/console' },
            { label: 'Operations & troubleshooting', slug: 'guides/operations' },
            { label: 'Platform: GCP', slug: 'guides/gcp' },
            { label: 'Platform: Azure', slug: 'guides/azure' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI commands', slug: 'reference/cli' },
            { label: 'Configuration', slug: 'reference/configuration' },
            { label: 'The engine contract', slug: 'reference/engine-contract' },
            { label: 'tendb-snapshotd', slug: 'reference/snapshotd' },
            { label: 'Terraform: engine module', slug: 'reference/terraform-engine' },
            { label: 'Terraform: network & console', slug: 'reference/terraform-network' },
          ],
        },
        {
          label: 'Comparison',
          items: [{ label: 'Neon parity', slug: 'comparison/neon-parity' }],
        },
      ],
    }),
  ],
});
