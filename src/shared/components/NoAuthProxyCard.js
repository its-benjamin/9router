"use client";

import { useCallback, useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Select from "./Select";
import Badge from "./Badge";
import Toggle from "./Toggle";
const NONE_PROXY_POOL_VALUE = "__none__";
const STRATEGIES = [
  { value: "none", label: "None (single pool)" },
  { value: "round-robin", label: "Round-robin" },
  { value: "random", label: "Random" },
];

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [rotateStrategy, setRotateStrategy] = useState("none");
  const [proxySaving, setProxySaving] = useState(false);
  const [cliSaving, setCliSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [opencodeInstalled, setOpencodeInstalled] = useState(true);
  const [cliEnabled, setCliEnabled] = useState(true);
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [copiedCmd, setCopiedCmd] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
      fetch("/api/providers", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData, providersData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      // A saved pool id can go stale if the pool was deleted after saving.
      // Only trust the override when it still resolves to a current option,
      // otherwise fall back to no proxy so the select never points at nothing.
      const savedPoolId = override.proxyPoolId;
      const poolStillExists =
        savedPoolId === NONE_PROXY_POOL_VALUE ||
        (poolData.proxyPools || []).some((p) => p.id === savedPoolId);
      setProxyPoolId(poolStillExists ? savedPoolId : NONE_PROXY_POOL_VALUE);
      setRotateStrategy(override.rotateStrategy || "none");
      if (providersData?.opencodeInstalled !== undefined) {
        setOpencodeInstalled(Boolean(providersData.opencodeInstalled));
      }
      if (settingsData?.opencodeCliEnabled !== undefined) {
        setCliEnabled(Boolean(settingsData.opencodeCliEnabled));
      }
      if (settingsData?.opencodeMaxConcurrency !== undefined) {
        setMaxConcurrency(Number(settingsData.opencodeMaxConcurrency) || 4);
      }
    }).catch(() => {});
  }, [providerId]);

  const save = useCallback(async (poolId, strategy) => {
    setProxySaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}) };
      if (poolId === NONE_PROXY_POOL_VALUE) delete override.proxyPoolId;
      else override.proxyPoolId = poolId;
      if (strategy === "none") delete override.rotateStrategy;
      else override.rotateStrategy = strategy;
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save proxy config error:", e);
    } finally {
      setProxySaving(false);
    }
  }, [providerId]);

  const handlePoolChange = (newPoolId) => {
    setProxyPoolId(newPoolId);
    save(newPoolId, rotateStrategy);
  };

  const handleStrategyChange = (newStrategy) => {
    setRotateStrategy(newStrategy);
    save(proxyPoolId, newStrategy);
  };

  const isOpenCode = providerId === "opencode" || providerId === "opencode-v2";

  const handleToggleCli = async (newVal) => {
    setCliEnabled(newVal);
    setCliSaving(true);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opencodeCliEnabled: newVal }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Error saving CLI enabled:", e);
    } finally {
      setCliSaving(false);
    }
  };

  const handleMaxConcurrencyChange = async (val) => {
    const num = Math.max(1, Math.min(32, parseInt(val, 10) || 4));
    setMaxConcurrency(num);
    setCliSaving(true);
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ opencodeMaxConcurrency: num }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Error saving concurrency limit:", e);
    } finally {
      setCliSaving(false);
    }
  };

  const concurrencyOptions = [
    { value: "1", label: "1 process (Strict Serial)" },
    { value: "2", label: "2 processes" },
    { value: "4", label: "4 processes (Recommended)" },
    { value: "8", label: "8 processes" },
    { value: "16", label: "16 processes (High Load)" },
  ];

  const canRotate = proxyPools.length >= 2;
  const isRotation = canRotate && rotateStrategy !== "none";

  const strategyOptions = STRATEGIES.map((s) => ({
    ...s,
    disabled: s.value !== "none" && !canRotate,
    label: s.value !== "none" && !canRotate ? `${s.label} (requires ≥2 pools)` : s.label,
  }));
  const proxyPoolOptions = [
    { value: NONE_PROXY_POOL_VALUE, label: "None (direct / unproxied)" },
    ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
  ];

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">
            Ready to use as-is, or route it through a proxy pool to bypass IP-based limits.
          </p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>

      <div className="space-y-4">
        <Select
          label="Proxy Source"
          value={proxyPoolId}
          onChange={(e) => handlePoolChange(e.target.value)}
          disabled={proxySaving || isRotation}
          options={proxyPoolOptions}
          hint={
            isRotation
              ? "Multi-pool rotation is active across all pools. Set rotation strategy to None to use a single fixed pool."
              : undefined
          }
        />

        {proxyPools.length > 0 && (
          <Select
            label="Rotation Strategy"
            value={canRotate ? rotateStrategy : "none"}
            onChange={(e) => handleStrategyChange(e.target.value)}
            disabled={proxySaving}
            options={strategyOptions}
            hint={
              canRotate
                ? isRotation
                  ? "Rotate across all active proxy pools on every request"
                  : "Single proxy pool mode (uses Proxy Source above)"
                : "Add at least 2 active proxy pools to enable multi-pool rotation"
            }
          />
        )}

        {isOpenCode && (
          <div className="pt-4 border-t border-border space-y-4">
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              <div className="flex items-center gap-1.5 font-semibold text-sm mb-1 text-amber-800 dark:text-amber-200">
                <span className="material-symbols-outlined text-[18px]">security</span>
                Host Process Execution & Security Warning
              </div>
              <p>
                OpenCode models use your local host CLI (<code>opencode run</code>) or network wire.
                Running host CLI spawns real child processes on this operating system.
                <strong> If 9Router is exposed to untrusted networks (0.0.0.0, public IP, tunnels without API keys), untrusted callers could invoke host operations.</strong>
              </p>
              <p className="mt-1">
                By default, remote (non-loopback) requests are automatically blocked from running host CLI processes. You can toggle host CLI execution below.
              </p>
            </div>

            <Toggle
              checked={cliEnabled}
              onChange={handleToggleCli}
              label="Host CLI Process Engine"
              description="Spawn local OpenCode CLI processes on this machine for prompt execution and client tool bridging. Disable to force all requests through external network wire."
            />

            <Select
              label="Max Concurrent CLI Processes"
              value={String(maxConcurrency)}
              onChange={(e) => handleMaxConcurrencyChange(e.target.value)}
              disabled={cliSaving || !cliEnabled}
              options={concurrencyOptions}
              hint="Cap simultaneous host CLI processes to prevent resource exhaustion."
            />
        )}
      </div>
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};