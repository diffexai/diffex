import { DIFFEX_LOGO_SVG } from "./diffex-logo.ts";

// Pixel rendition of the entrance animation's rotor, cabin, portholes, hull, and wake.
const BOAT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 48" shape-rendering="crispEdges" aria-hidden="true">
  <g fill="#82aaff">
    <path d="M46 2h2v20h-2z M38 2h2v2h-2z M40 4h2v2h-2z M42 6h2v2h-2z M44 8h2v2h-2z M54 2h2v2h-2z M52 4h2v2h-2z M50 6h2v2h-2z M48 8h2v2h-2z M36 10h10v2H36z M48 10h10v2H48z"/>
    <path d="M34 20h26v2H34z M32 22h2v2h-2z M60 22h2v2h-2z M30 24h2v4h-2z M62 24h2v4h-2z M26 28h4v2h-4z M64 28h6v2h-6z M20 30h6v2h-6z M70 30h8v2h-8z"/>
  </g>
  <path fill="#a9c4ff" d="M18 32h62v2h-2v2h-2v2h-4v2H28v-2h-4v-2h-4v-2h-2z"/>
  <path fill="#5d7eaf" d="M28 38h44v2H28z M34 22h26v2H34z"/>
  <path fill="#ccd9f5" d="M39 25h4v4h-4z M53 25h4v4h-4z"/>
  <g fill="#82aaff" opacity=".45">
    <path d="M2 36h10v1H2z M82 36h10v1H82z M12 42h12v1H12z M30 44h14v1H30z M51 43h12v1H51z M70 42h14v1H70z M4 47h18v1H4z M40 48h18v1H40z M78 47h18v1H78z"/>
  </g>
</svg>`;

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function renderPage(options: { title: string; heading: string; message: string; details?: string }): string {
	const title = escapeHtml(options.title);
	const heading = escapeHtml(options.heading);
	const message = escapeHtml(options.message);
	const details = options.details ? escapeHtml(options.details) : undefined;

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --text: #fafafa;
      --text-dim: #a1a1aa;
      --page-bg: #09090b;
      --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; }
    html { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow-wrap: anywhere;
      padding: 24px;
      background: var(--page-bg);
      color: var(--text);
      font-family: var(--font-sans);
      text-align: center;
    }
    .scene {
      position: fixed;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
    }
    .boat {
      position: absolute;
      left: 50%;
      bottom: 5vh;
      width: min(520px, 90vw);
      transform: translateX(-50%);
      opacity: .2;
    }
    main {
      position: relative;
      width: 100%;
      max-width: 560px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin-bottom: 24px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
      line-height: 1.15;
      font-weight: 650;
      color: var(--text);
      text-wrap: balance;
    }
    p {
      margin: 0;
      line-height: 1.7;
      color: var(--text-dim);
      font-size: 15px;
    }
    .details {
      margin-top: 16px;
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-dim);
      white-space: pre-wrap;
      word-break: break-word;
    }
    @media (max-height: 600px) {
      .boat { bottom: -48px; opacity: .07; }
    }
  </style>
</head>
<body>
  <div class="scene" aria-hidden="true"><div class="boat">${BOAT_SVG}</div></div>
  <main>
    <div class="logo">${DIFFEX_LOGO_SVG}</div>
    <h1>${heading}</h1>
    <p>${message}</p>
    ${details ? `<div class="details">${details}</div>` : ""}
  </main>
</body>
</html>`;
}

export function oauthSuccessHtml(message = "You can close this tab and return to Diffex."): string {
	return renderPage({
		title: "Continue in Diffex",
		heading: "Continue in Diffex",
		message,
	});
}

export function oauthErrorHtml(message: string, details?: string): string {
	return renderPage({
		title: "Diffex sign-in error",
		heading: "Could not complete sign-in",
		message: "Return to Diffex and run /login to try again.",
		details: [message, details].filter(Boolean).join("\n"),
	});
}
