import chalk from "chalk";
import { createHash } from "crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync } from "fs";
import { rename, rm } from "fs/promises";
import { arch, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as tarStream from "tar-stream";
import * as yauzl from "yauzl";
import { createGunzip } from "zlib";
import { getBinDir } from "../config.js";
import { spawnSyncHidden } from "./child-process.js";

const TOOLS_DIR = getBinDir();
const DOWNLOAD_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 5_000;
const RIPGREP_INSTALL_URL = "https://github.com/BurntSushi/ripgrep#installation";

export type ManagedTool = "fd" | "rg";

export type ToolUnavailableReason = "offline" | "manual_install_required" | "unsupported_platform" | "download_failed";

export interface ToolAvailableResult {
	status: "available";
	path: string;
}

export interface ToolUnavailableResult {
	status: "unavailable";
	reason: ToolUnavailableReason;
	platform: string;
	architecture: string;
	detail?: string;
}

export type ToolEnsureResult = ToolAvailableResult | ToolUnavailableResult;

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

interface PinnedAsset {
	assetName: string;
	sha256: string;
	entryName: string;
}
interface ToolConfig {
	name: string;
	repo: string;
	binaryName: string;
	systemBinaryNames?: string[];
	getAsset: (plat: string, architecture: string) => PinnedAsset | null;
}
const pinned = (assetName: string, sha256: string, entryName: string): PinnedAsset => ({
	assetName,
	sha256,
	entryName,
});
const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		getAsset: (p, a) => {
			const archName = a === "arm64" ? "aarch64" : a === "x64" ? "x86_64" : null;
			if (!archName) return null;
			if (p === "darwin")
				return pinned(
					`fd-v10.5.0-${archName}-apple-darwin.tar.gz`,
					{
						arm64: "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12",
						x64: "7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590",
					}[a]!,
					`fd-v10.5.0-${archName}-apple-darwin/fd`,
				);
			if (p === "linux")
				return pinned(
					`fd-v10.5.0-${archName}-unknown-linux-gnu.tar.gz`,
					{
						arm64: "c0ee43802e3313a317c5af2f4eabd6ba13eeedd595af9775f05e18a13ac4f52c",
						x64: "a1259cd129636efbc3fef123525c1b49e88fe5088c012630983c310e52fdfa95",
					}[a]!,
					`fd-v10.5.0-${archName}-unknown-linux-gnu/fd`,
				);
			if (p === "win32")
				return pinned(
					`fd-v10.5.0-${archName}-pc-windows-msvc.zip`,
					{
						arm64: "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6",
						x64: "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7",
					}[a]!,
					`fd-v10.5.0-${archName}-pc-windows-msvc/fd.exe`,
				);
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		getAsset: (p, a) => {
			const archName = a === "arm64" ? "aarch64" : a === "x64" ? "x86_64" : null;
			if (!archName) return null;
			const suffix =
				p === "darwin"
					? `${archName}-apple-darwin`
					: p === "linux"
						? a === "arm64"
							? "aarch64-unknown-linux-gnu"
							: "x86_64-unknown-linux-musl"
						: p === "win32"
							? `${archName}-pc-windows-msvc`
							: null;
			if (!suffix) return null;
			const ext = p === "win32" ? "zip" : "tar.gz";
			const name = `ripgrep-15.2.0-${suffix}.${ext}`;
			const hashes: Record<string, string> = {
				"aarch64-apple-darwin": "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
				"x86_64-apple-darwin": "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
				"aarch64-unknown-linux-gnu": "a740b91c82eaf9914cfedd353572f2791cbe0162c84101ee0951058f4dcbc90d",
				"x86_64-unknown-linux-musl": "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
				"aarch64-pc-windows-msvc": "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
				"x86_64-pc-windows-msvc": "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
			};
			return pinned(name, hashes[suffix], `ripgrep-15.2.0-${suffix}/rg${p === "win32" ? ".exe" : ""}`);
		},
	},
};

// Check that a command both launches and reports a successful version.
function commandWorks(cmd: string): boolean {
	try {
		const result = spawnSyncHidden(cmd, ["--version"], { stdio: "pipe", timeout: COMMAND_TIMEOUT_MS });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: ManagedTool): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath) && commandWorks(localPath)) {
		return localPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandWorks(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

// Download a file from URL
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), fileStream);
}

// Download and install a tool
class UnsupportedToolPlatformError extends Error {}

const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
async function sha256File(path: string): Promise<string> {
	const h = createHash("sha256");
	await pipeline(createReadStream(path), h);
	return h.digest("hex");
}
function extractZipEntry(archive: string, entryName: string, dest: string): Promise<void> {
	return new Promise((resolve, reject) => {
		yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (err, zip) => {
			if (err || !zip) return reject(err ?? new Error("failed to open zip"));
			let matches = 0;
			zip.on("error", reject);
			zip.on("entry", (entry) => {
				if (entry.fileName !== entryName) return zip.readEntry();
				matches++;
				if (matches > 1 || entry.fileName.endsWith("/") || entry.uncompressedSize > MAX_ENTRY_BYTES)
					return reject(new Error("invalid pinned zip entry"));
				zip.openReadStream(entry, (e, stream) => {
					if (e || !stream) return reject(e ?? new Error("failed to read zip entry"));
					pipeline(stream, createWriteStream(dest, { flags: "wx", mode: 0o600 })).then(
						() => zip.readEntry(),
						reject,
					);
				});
			});
			zip.on("end", () => (matches === 1 ? resolve() : reject(new Error(`pinned entry not found: ${entryName}`))));
			zip.readEntry();
		});
	});
}
async function extractTarEntry(archive: string, entryName: string, dest: string): Promise<void> {
	const extract = tarStream.extract();
	let matches = 0;
	let output: ReturnType<typeof createWriteStream> | undefined;
	extract.on("entry", (header, stream, next) => {
		if (header.name !== entryName) {
			stream.resume();
			stream.once("end", next);
			return;
		}
		matches++;
		if (matches > 1 || header.type !== "file" || (header.size ?? 0) > MAX_ENTRY_BYTES) {
			stream.resume();
			extract.destroy(new Error("invalid pinned tar entry"));
			return;
		}
		output = createWriteStream(dest, { flags: "wx", mode: 0o600 });
		pipeline(stream, output).then(
			() => next(),
			(e) => extract.destroy(e),
		);
	});
	const done = new Promise<void>((resolve, reject) => {
		extract.once("finish", () =>
			matches === 1 ? resolve() : reject(new Error(`pinned entry not found: ${entryName}`)),
		);
		extract.once("error", reject);
	});
	await pipeline(createReadStream(archive), createGunzip(), extract);
	await done;
}
async function downloadTool(tool: ManagedTool): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);
	const asset = config.getAsset(platform(), arch());
	if (!asset) throw new UnsupportedToolPlatformError(`Unsupported platform: ${platform()}/${arch()}`);
	mkdirSync(TOOLS_DIR, { recursive: true });
	const archivePath = join(TOOLS_DIR, asset.assetName);
	const binaryPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	const tempPath = `${binaryPath}.${process.pid}.${Date.now()}.part`;
	try {
		await downloadFile(
			`https://github.com/${config.repo}/releases/download/${config.repo === "sharkdp/fd" ? "v10.5.0" : "15.2.0"}/${asset.assetName}`,
			archivePath,
		);
		if ((await sha256File(archivePath)) !== asset.sha256) throw new Error(`SHA-256 mismatch for ${asset.assetName}`);
		if (asset.assetName.endsWith(".zip")) await extractZipEntry(archivePath, asset.entryName, tempPath);
		else await extractTarEntry(archivePath, asset.entryName, tempPath);
		if (platform() !== "win32") chmodSync(tempPath, 0o755);
		if (!commandWorks(tempPath)) throw new Error(`Installed ${config.name} binary failed its version check`);
		await rename(tempPath, binaryPath);
		if (!commandWorks(binaryPath)) throw new Error(`Published ${config.name} binary failed its version check`);
		return binaryPath;
	} finally {
		await rm(archivePath, { force: true }).catch(() => undefined);
		await rm(tempPath, { force: true }).catch(() => undefined);
	}
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

function getRipgrepInstallHint(platformName: string): string {
	switch (platformName) {
		case "darwin":
			return "Install it with: brew install ripgrep";
		case "linux":
			return `Install it with your package manager (for example, sudo apt install ripgrep or sudo dnf install ripgrep). See ${RIPGREP_INSTALL_URL}`;
		case "win32":
			return "Install it with: winget install BurntSushi.ripgrep.MSVC";
		case "android":
			return "Install it with: pkg install ripgrep";
		default:
			return `Install ripgrep manually: ${RIPGREP_INSTALL_URL}`;
	}
}

export function formatMissingRipgrepMessage(result: ToolUnavailableResult): string {
	let reason: string;
	switch (result.reason) {
		case "offline":
			reason = "Automatic installation was skipped because PI_OFFLINE is enabled.";
			break;
		case "manual_install_required":
			reason = "Prime Agent cannot install this helper automatically in Termux.";
			break;
		case "unsupported_platform":
			reason = `Automatic installation is unavailable for ${result.platform}/${result.architecture}.`;
			break;
		case "download_failed": {
			const detail = result.detail?.replace(/\s+/g, " ").trim();
			reason = detail
				? `Prime Agent could not install it automatically: ${detail}`
				: "Prime Agent could not install it automatically.";
			break;
		}
	}

	return [
		"ripgrep (rg) is an optional search helper. Without it, model-run file searches may be slower or fail; Prime Agent and subagents remain available.",
		reason,
		getRipgrepInstallHint(result.platform),
	].join("\n");
}

// Ensure a tool is available, downloading if necessary, and retain why provisioning failed.
export async function ensureToolWithStatus(tool: ManagedTool, silent: boolean = true): Promise<ToolEnsureResult> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return { status: "available", path: existingPath };
	}

	const config = TOOLS[tool];
	const platformName = platform();
	const architecture = arch();

	if (isOfflineModeEnabled()) {
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Offline mode enabled, skipping download.`));
		}
		return { status: "unavailable", reason: "offline", platform: platformName, architecture };
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platformName === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${pkgName}`));
		}
		return {
			status: "unavailable",
			reason: "manual_install_required",
			platform: platformName,
			architecture,
		};
	}

	// Tool not found - download it
	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading...`));
	}

	try {
		const path = await downloadTool(tool);
		if (!silent) {
			console.log(chalk.dim(`${config.name} installed to ${path}`));
		}
		return { status: "available", path };
	} catch (e) {
		if (!silent) {
			console.log(chalk.yellow(`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`));
		}
		return {
			status: "unavailable",
			reason: e instanceof UnsupportedToolPlatformError ? "unsupported_platform" : "download_failed",
			platform: platformName,
			architecture,
			detail: e instanceof Error ? e.message : String(e),
		};
	}
}

// Compatibility wrapper for callers that only need the resolved executable path.
export async function ensureTool(tool: ManagedTool, silent: boolean = true): Promise<string | undefined> {
	const result = await ensureToolWithStatus(tool, silent);
	return result.status === "available" ? result.path : undefined;
}
