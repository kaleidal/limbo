import { defineConfig } from "cf/config";

export default defineConfig({
	accountId: "ab780d52c6d4df0c826897411f1558e0",
	worker: {
		name: "limbo-marketing",
		compatibilityDate: "2026-08-24",
		entrypoint: "marketing/worker/index.ts",
		observability: {
			enabled: true,
		},
		assets: {
			notFoundHandling: "404-page",
			runWorkerFirst: [
				"/download/*",
				"/api/release",
			],
		},
		domains: [
			"limbo.kaleid.al",
		],
	},
});
