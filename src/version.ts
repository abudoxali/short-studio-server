/**
 * The identity of this build. The updater compares the version here against the
 * version in a published release manifest, so it must always describe the code
 * that is actually running - not the newest version that exists.
 */
export const PRODUCT_NAME = "Short Studio Server";
export const PRODUCT_BRAND = "Short Studio";
/** Filename-safe slug for customer-facing artifact names (downloads, backups). */
export const PRODUCT_SLUG = "short-studio";
/** Shown only in migration/history contexts (e.g. "Upgraded from ABUD Shorts Engine 2.4"). */
export const PREVIOUS_PRODUCT_NAME = "ABUD Shorts Engine";
export const PREVIOUS_PRODUCT_VERSION = "2.4.0";
export const PRODUCT_VERSION = "2.6.0";
export const PRODUCT_STAGE = "Commercial Quality Recovery Candidate";
export const PRODUCT_BUILD = "2026.09.12.1";
/**
 * The highest migration in `MIGRATIONS`. `verifySchemaVersion()` in the
 * migration runner fails the build if the two drift apart: a stale constant here
 * makes the updater report a schema it never actually applied.
 */
export const DATABASE_SCHEMA_VERSION = "2.14.0";

/** Release channels a client installation may follow. Clients default to stable. */
export type ReleaseChannel = "stable" | "development";

export const DEFAULT_RELEASE_CHANNEL: ReleaseChannel = "stable";

export function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return value === "stable" || value === "development";
}

/**
 * The channel this installation follows. An installation only leaves `stable`
 * when the operator sets SHORT_STUDIO_RELEASE_CHANNEL explicitly, so a client is
 * never moved onto a development build by a default. ABUD_RELEASE_CHANNEL is
 * read as a fallback so an installation upgraded from ABUD Shorts Engine 2.4
 * that never rewrote its .env keeps following the channel it already chose.
 */
export function getReleaseChannel(): ReleaseChannel {
  const configured = (
    process.env.SHORT_STUDIO_RELEASE_CHANNEL ||
    process.env.ABUD_RELEASE_CHANNEL ||
    ""
  )
    .trim()
    .toLowerCase();
  return isReleaseChannel(configured) ? configured : DEFAULT_RELEASE_CHANNEL;
}

export function getProductInfo() {
  return {
    name: PRODUCT_NAME,
    brand: PRODUCT_BRAND,
    version: PRODUCT_VERSION,
    stage: PRODUCT_STAGE,
    build: PRODUCT_BUILD,
    schemaVersion: DATABASE_SCHEMA_VERSION,
    releaseChannel: getReleaseChannel(),
    canonicalUrl: getCanonicalPublicUrl(),
    // Repository has not been renamed yet (short-studio-server migration is
    // code/package-safe first, rename last) - this must keep resolving to the
    // real repo, not a name that does not exist yet.
    docsUrl: "https://github.com/3bud-ZC/Abud-Shorts-Engine",
    previousProduct: `${PREVIOUS_PRODUCT_NAME} ${PREVIOUS_PRODUCT_VERSION}`,
  };
}

/**
 * The address customers reach this installation on. A VPS install serves a real
 * domain, so localhost is only the fallback for an installation that never
 * configured one.
 */
export function getCanonicalPublicUrl(): string {
  const configured = (process.env.V2_PUBLIC_URL || "").trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  const port = process.env.HOST_PORT || process.env.PORT || "3130";
  return `http://localhost:${port}`;
}
