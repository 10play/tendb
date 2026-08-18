// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'tendb',
      description:
        'Neon-style Postgres branching on your own AWS account, powered by DBLab Engine.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/10play/tendb' },
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
