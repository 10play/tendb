// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

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
        'Neon-style Postgres branching on your own AWS account, powered by DBLab Engine.',
      logo: { src: './src/assets/tendb-mark.svg', alt: 'tendb' },
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
            { label: 'Quickstart', slug: 'getting-started/quickstart' },
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
