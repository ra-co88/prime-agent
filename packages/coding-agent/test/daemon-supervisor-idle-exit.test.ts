import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface SupervisorInternals {
	clients: Set<object>;
	shuttingDown: boolean;
	lastClientDisconnectAt?: number;
	supervisorIdleExitTimer?: ReturnType<typeof setTimeout>;
	supervisorIdleExitDelayMs(now?: number): number | undefined;
	scheduleSupervisorIdleExitCheck(): void;
	checkSupervisorIdleExit(): void;
	shutdown(exitCode: number, stopWorkers: boolean): Promise<never>;
	log: ReturnType<typeof vi.fn>;
	descriptorDir: string;
	socketPath: string;
	defaultSessionConfig: { agentDir?: string };
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeSupervisor(supervisorExitWhenIdleMinutes: number | "off" | undefined): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-idle-exit-"));
	tempDirs.push(directory);
	const settings: Record<string, unknown> = {};
	if (supervisorExitWhenIdleMinutes !== undefined) {
		settings.supervisorExitWhenIdleMinutes = supervisorExitWhenIdleMinutes;
	}
	writeFileSync(join(directory, "settings.json"), JSON.stringify(settings));
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorInternals;
	supervisor.log = vi.fn();
	supervisor.shuttingDown = false;
	return supervisor;
}

describe("daemon supervisor idle exit", () => {
	it("defaults to off when the setting is absent", () => {
		const supervisor = makeSupervisor(undefined);
		expect(supervisor.supervisorIdleExitDelayMs()).toBeUndefined();
	});

	it("honors off after the setting is written", () => {
		const supervisor = makeSupervisor("off");
		expect(supervisor.supervisorIdleExitDelayMs()).toBeUndefined();
	});

	it("exits immediately when the clientless window already elapsed", () => {
		const supervisor = makeSupervisor(30);
		supervisor.lastClientDisconnectAt = Date.now() - 31 * 60_000;
		expect(supervisor.supervisorIdleExitDelayMs()).toBe(0);
	});

	it("returns the remaining clientless window", () => {
		const supervisor = makeSupervisor(30);
		supervisor.lastClientDisconnectAt = Date.now() - 10 * 60_000;
		const delay = supervisor.supervisorIdleExitDelayMs();
		expect(delay).toBeGreaterThan(19 * 60_000);
		expect(delay).toBeLessThanOrEqual(20 * 60_000);
	});

	it("treats startup with no prior clients as an idle clock already running", () => {
		const supervisor = makeSupervisor(30);
		expect(supervisor.supervisorIdleExitDelayMs()).toBe(30 * 60_000);
	});

	it("holds the exit while any client stays connected", () => {
		const supervisor = makeSupervisor(30);
		supervisor.clients.add({ id: "viewer" });
		supervisor.lastClientDisconnectAt = Date.now() - 60 * 60_000;
		expect(supervisor.supervisorIdleExitDelayMs()).toBeUndefined();
	});

	it("arms an unref'd timer that exits after the clientless window", async () => {
		vi.useFakeTimers();
		try {
			const supervisor = makeSupervisor(30);
			const shutdown = vi.fn();
			supervisor.shutdown = shutdown as unknown as SupervisorInternals["shutdown"];
			// start() seeds the idle clock when it boots with no connected clients.
			supervisor.lastClientDisconnectAt = Date.now();
			supervisor.scheduleSupervisorIdleExitCheck();
			expect(supervisor.supervisorIdleExitTimer).toBeDefined();

			await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
			expect(shutdown).not.toHaveBeenCalled();
			expect(supervisor.log).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("shutting down"));
			expect(shutdown).toHaveBeenCalledWith(0, true, false, false, "idle_exit");
		} finally {
			vi.useRealTimers();
		}
	});

	it("ignores a stale timer firing after a client connected", () => {
		const supervisor = makeSupervisor(30);
		supervisor.clients.add({ id: "viewer" });
		supervisor.checkSupervisorIdleExit();
		expect(supervisor.log).not.toHaveBeenCalled();
	});

	it("does not arm a timer when a client is already connected", () => {
		const supervisor = makeSupervisor(30);
		supervisor.clients.add({ id: "viewer" });
		supervisor.scheduleSupervisorIdleExitCheck();
		expect(supervisor.supervisorIdleExitTimer).toBeUndefined();
	});

	it("re-arms instead of exiting when clients reconnect before the window elapses", () => {
		vi.useFakeTimers();
		try {
			const supervisor = makeSupervisor(30);
			supervisor.scheduleSupervisorIdleExitCheck();
			const shutdown = vi.fn();
			supervisor.shutdown = shutdown as unknown as SupervisorInternals["shutdown"];

			// A client arrives at minute 29 and leaves again at minute 29.5.
			const client = { id: "late-viewer" };
			supervisor.clients.add(client);
			vi.advanceTimersByTime(29 * 60_000);
			supervisor.clients.delete(client);
			supervisor.lastClientDisconnectAt = Date.now();
			supervisor.scheduleSupervisorIdleExitCheck();

			vi.advanceTimersByTime(29 * 60_000);
			expect(shutdown).not.toHaveBeenCalled();
			expect(supervisor.log).not.toHaveBeenCalled();

			vi.advanceTimersByTime(60_000);
			expect(supervisor.log).toHaveBeenCalledWith(expect.stringContaining("shutting down"));
		} finally {
			vi.useRealTimers();
		}
	});

	it("never exits once shutdown has begun", () => {
		vi.useFakeTimers();
		try {
			const supervisor = makeSupervisor(30);
			supervisor.shuttingDown = true;
			supervisor.scheduleSupervisorIdleExitCheck();
			expect(supervisor.supervisorIdleExitTimer).toBeUndefined();

			supervisor.checkSupervisorIdleExit();
			expect(supervisor.log).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
