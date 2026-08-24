# Themes

Choose **Settings → Style** to select Standard, Moonlight, NVIDIA, or one configured custom theme. Theme selection is saved in the browser.

## Create and reference a theme

1. Create a CSS file that overrides the semantic theme variables. Start with:

   ```css
   :root {
     --ml-theme-font: Inter, Arial, sans-serif;
     --ml-theme-canvas: #101418;
     --ml-theme-canvas-alt: #182028;
     --ml-theme-surface: rgba(24, 32, 40, 0.97);
     --ml-theme-surface-alt: rgba(16, 20, 24, 0.98);
     --ml-theme-text: #ffffff;
     --ml-theme-text-muted: #c4ccd4;
     --ml-theme-accent: #58a6ff;
     --ml-theme-accent-strong: #79b8ff;
     --ml-theme-on-accent: #081018;
     --ml-theme-border: #52606d;
     --ml-theme-danger: #ff6b6b;
     --ml-theme-focus: #a8d1ff;
     --ml-theme-radius-sm: 4px;
     --ml-theme-radius-md: 8px;
     --ml-theme-radius-lg: 12px;
     --ml-theme-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
   }
   ```

2. Serve the file over HTTPS. You can copy it to `static/themes/my-theme.css` in a release deployment, `dist/themes/my-theme.css` in a debug deployment, or serve it from NGINX/CDN.

3. Reference it in `server/config.json`:

   ```json
   {
     "web_server": {
       "custom_theme": {
         "id": "my-theme",
         "label": "My Theme",
         "stylesheet": "themes/my-theme.css"
       }
     }
   }
   ```

   The `id` may contain letters, numbers, `_`, and `-`; it cannot be `standard`, `moonlight`, `old`, or `nvidia`. Relative stylesheet URLs follow `url_path_prefix`. An absolute HTTPS URL also works.

4. Restart Moonlight Web and select **My Theme** in Style.

Custom CSS loads after the Standard theme, so it can also add narrowly scoped component rules when variables are not enough. Keep the stylesheet under your control: it runs in every user's browser.

## NVIDIA theme

The built-in NVIDIA option follows NVIDIA's [Kaizen guidance for external/open-source projects](https://virtual-front-end-initiative.gitlab-master-pages.nvidia.com/kaizen-ui-foundations/get-started/installation/#open-source--external-projects). It loads both pinned Kaizen external stylesheets (`base-external.css` and `components.css`) and maps Moonlight Web controls to Kaizen app-bar, button, and card classes. The adapter also applies NVIDIA green, near-black semantic surfaces, compact density, Kaizen focus states, NVIDIA/Lucide-style icons, and reduced-motion support. It is selectable without additional configuration.

The background specifically adapts the full Docsify landing/cover design from LaunchPad Docs v2 (`lp/util/roles/docs/files/docsify-base/_static/{css,js}/launchpad-v2.*`), not its compact overview-header treatment. It uses the cover's 11-by-8 deterministic triangular mesh with a 13.5-second NVIDIA-green traveling field and radial glow. The mesh extends past the left viewport edge, while its visibility tapers smoothly to zero at the left and becomes fully visible toward the right. No separate grid overlay is added. It is implemented locally, so a Moonlight Web deployment does not depend on the Ansible docs repository. Browsers requesting reduced motion receive the mesh as a static frame with no traveling highlight.

Kaizen's external base uses a local `NVIDIA Sans` installation when one is available and supplies its metric-compatible fallback otherwise. Moonlight Web intentionally uses that Kaizen font stack rather than downloading or redistributing NVIDIA's licensed font files.

The Kaizen dependency is pinned in `web/styles/nvidia.css`. Review and update that version deliberately when upgrading the theme foundation.
