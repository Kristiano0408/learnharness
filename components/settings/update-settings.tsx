"use client";

import { SettingsRow } from "./controls.tsx";

export const APP_VERSION = process.env.LH_VERSION ?? "";
const HOMEPAGE = process.env.LH_HOMEPAGE ?? "";

/** Manual-updates-only wording (owner ruling, 2026-10-29): the updater is
 * gone — an installed build silently self-updated over the baked upstream
 * feed and replaced local rebuilds with upstream binaries after a restart.
 * Nothing in-app may download or install; the human checks GitHub Releases
 * and installs a chosen artifact manually. */
export const MANUAL_UPDATE_HINT = "Updates are manual: check GitHub Releases for newer versions and install one yourself.";

/** Version information is useful everywhere; no updater controls exist. */
export function UpdateSettings({
	version = APP_VERSION,
	homepage = HOMEPAGE,
}: {
	version?: string;
	homepage?: string;
}) {
	const releaseNotes = version && homepage ? `${homepage}/releases/tag/v${version}` : null;

	return (
		<SettingsRow
			label={`Version ${version || "unknown"}`}
			testid="row-version"
			hint={
				<>
					<span className="block">{MANUAL_UPDATE_HINT}</span>
					{releaseNotes && <a href={releaseNotes} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline" data-testid="release-notes">Release notes</a>}
				</>
			}
		>
			<span />
		</SettingsRow>
	);
}
