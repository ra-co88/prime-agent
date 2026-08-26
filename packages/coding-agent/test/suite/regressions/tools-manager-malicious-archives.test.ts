import { createWriteStream } from "fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pipeline } from "stream/promises";
import * as tarStream from "tar-stream";
import { afterEach, describe, expect, test } from "vitest";
import * as yazl from "yazl";
import { createGzip } from "zlib";
import {
	extractTarEntryForTest,
	extractZipEntryForTest,
	publishVerifiedFileForTest,
} from "../../../src/utils/tools-manager.js";

const roots: string[] = [];
async function fixturePaths(extension: string) {
	const root = await mkdtemp(join(tmpdir(), "prime-agent-archive-test-"));
	roots.push(root);
	return { archive: join(root, `fixture.${extension}`), output: join(root, "tool"), root };
}
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeZip(path: string, entries: Array<{ name: string; data: string; mode?: number }>) {
	const zip = new yazl.ZipFile();
	for (const entry of entries) zip.addBuffer(Buffer.from(entry.data), entry.name, { mode: entry.mode ?? 0o100644 });
	zip.end();
	await pipeline(zip.outputStream, createWriteStream(path));
}

async function writeTar(path: string, entries: Array<{ name: string; data: string; type?: tarStream.Header["type"] }>) {
	const pack = tarStream.pack();
	for (const entry of entries) {
		const type = entry.type ?? "file";
		pack.entry(
			type === "symlink" ? { name: entry.name, type, linkname: entry.data, size: 0 } : { name: entry.name, type },
			type === "symlink" ? Buffer.alloc(0) : Buffer.from(entry.data),
		);
	}
	pack.finalize();
	await pipeline(pack, createGzip(), createWriteStream(path));
}

async function expectRejectedWithoutOutput(action: () => Promise<void>, output: string) {
	await expect(action()).rejects.toThrow();
	await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("managed tool malicious archive rejection", () => {
	test("rejects duplicate pinned ZIP entries", async () => {
		const { archive, output } = await fixturePaths("zip");
		await writeZip(archive, [
			{ name: "release/tool", data: "first" },
			{ name: "release/tool", data: "second" },
		]);
		await expectRejectedWithoutOutput(() => extractZipEntryForTest(archive, "release/tool", output), output);
	});

	test("rejects duplicate pinned TAR entries", async () => {
		const { archive, output } = await fixturePaths("tar.gz");
		await writeTar(archive, [
			{ name: "release/tool", data: "first" },
			{ name: "release/tool", data: "second" },
		]);
		await expectRejectedWithoutOutput(() => extractTarEntryForTest(archive, "release/tool", output), output);
	});

	test("rejects a ZIP symlink at the pinned member", async () => {
		const { archive, output } = await fixturePaths("zip");
		await writeZip(archive, [{ name: "release/tool", data: "../../.zshrc", mode: 0o120777 }]);
		await expectRejectedWithoutOutput(() => extractZipEntryForTest(archive, "release/tool", output), output);
	});

	test("rejects a TAR symlink at the pinned member", async () => {
		const { archive, output } = await fixturePaths("tar.gz");
		await writeTar(archive, [{ name: "release/tool", data: "../../.zshrc", type: "symlink" }]);
		await expectRejectedWithoutOutput(() => extractTarEntryForTest(archive, "release/tool", output), output);
	});

	test.each(["zip", "tar.gz"])("rejects malformed %s input", async (format) => {
		const { archive, output } = await fixturePaths(format);
		await writeFile(archive, "not an archive");
		const extract = format === "zip" ? extractZipEntryForTest : extractTarEntryForTest;
		await expectRejectedWithoutOutput(() => extract(archive, "release/tool", output), output);
	});

	test("rejects an oversized ZIP member before publication", async () => {
		const { archive, output } = await fixturePaths("zip");
		await writeZip(archive, [{ name: "release/tool", data: "12345" }]);
		await expectRejectedWithoutOutput(() => extractZipEntryForTest(archive, "release/tool", output, 4), output);
	});

	test("rejects an oversized TAR member before publication", async () => {
		const { archive, output } = await fixturePaths("tar.gz");
		await writeTar(archive, [{ name: "release/tool", data: "12345" }]);
		await expectRejectedWithoutOutput(() => extractTarEntryForTest(archive, "release/tool", output, 4), output);
	});

	test("preserves an existing binary when staged replacement validation fails", async () => {
		const { root } = await fixturePaths("unused");
		const existing = join(root, "tool");
		const staged = join(root, "tool.part");
		await writeFile(existing, "known-good");
		await writeFile(staged, "malicious-or-corrupt");

		await expect(publishVerifiedFileForTest(staged, existing, () => false)).rejects.toThrow(
			"staged binary failed its version check",
		);
		expect(await readFile(existing, "utf8")).toBe("known-good");
		expect(await readFile(staged, "utf8")).toBe("malicious-or-corrupt");
	});
});
