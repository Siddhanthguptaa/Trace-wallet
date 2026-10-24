"""Probe the toolchain and the Base network; write results/toolchain.json (BUILD.md M0 step 2).

Usage: python tools/toolchain.py   (stdlib only; uses cast for chain reads)
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME = os.path.expanduser("~")
FOUNDRY_BIN = os.environ.get("FOUNDRY_BIN") or os.path.join(HOME, ".foundry", "bin")
EP = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
USDC_SEP = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3"


def env_value(key, default):
    if os.environ.get(key):
        return os.environ[key]
    for name in (".env", ".env.example"):
        p = os.path.join(ROOT, name)
        if os.path.exists(p):
            for line in open(p, encoding="utf-8"):
                m = re.match(rf"^\s*{key}\s*=\s*(\S+)", line)
                if m:
                    return m.group(1)
    return default


def which(name):
    exe = name + (".exe" if os.name == "nt" else "")
    cand = os.path.join(FOUNDRY_BIN, exe)
    if name in ("forge", "anvil", "cast") and os.path.exists(cand):
        return cand
    return shutil.which(name) or shutil.which(name + ".cmd")


def version(name, args=("--version",), pick=0):
    path = which(name)
    if not path:
        return f"deferred: {name} not found"
    try:
        out = subprocess.run([path, *args], capture_output=True, text=True, timeout=120)
        lines = [l.strip() for l in (out.stdout + out.stderr).splitlines() if l.strip()]
        return lines[pick] if lines else f"deferred: {name} printed nothing"
    except Exception as e:  # noqa: BLE001
        return f"deferred: {name}: {e}"


def cast(*args):
    out = subprocess.run([which("cast"), *args], capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:300])
    return out.stdout.strip()


def code_bytes(addr, rpc, block=None):
    extra = ["--block", str(block)] if block else []
    return (len(cast("code", addr, "--rpc-url", rpc, *extra)) - 2) // 2


def main():
    base = env_value("BASE_RPC", "https://mainnet.base.org")
    sep = env_value("BASE_SEPOLIA_RPC", "https://sepolia.base.org")
    fork_block = int(env_value("FORK_BLOCK", "53026000"))
    t = {
        "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "forge": version("forge"),
        "anvil": version("anvil"),
        "cast": version("cast"),
        "halmos": version("halmos", pick=-1),
        "slither": version("slither", pick=-1),
        "node": version("node"),
        "pnpm": version("pnpm"),
        "python": sys.version.split()[0],
        "uv": version("uv"),
        "foundryBin": FOUNDRY_BIN,
    }
    try:
        out = subprocess.run([which("ollama"), "list"], capture_output=True, text=True, timeout=60).stdout
        t["ollamaModels"] = [l.split()[0] for l in out.splitlines()[1:] if l.strip()]
    except Exception as e:  # noqa: BLE001
        t["ollamaModels"] = f"deferred: {e}"

    t["baseRpc"], t["baseSepoliaRpc"] = base, sep
    t["baseChainId"] = int(cast("chain-id", "--rpc-url", base))
    t["baseSepoliaChainId"] = int(cast("chain-id", "--rpc-url", sep))
    t["baseHead"] = int(cast("block-number", "--rpc-url", base))
    t["forkBlock"] = fork_block
    t["entryPointV08CodeBytes"] = code_bytes(EP, base)
    t["entryPointV08CodeBytesSepolia"] = code_bytes(EP, sep)
    t["entryPointV08CodeBytesAtForkBlock"] = code_bytes(EP, base, fork_block)
    t["entryPointV08HasCode"] = t["entryPointV08CodeBytes"] > 0 and t["entryPointV08CodeBytesSepolia"] > 0
    dom = cast("call", EP, "eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[])", "--rpc-url", base)
    lines = dom.splitlines()
    t["entryPointDomain"] = {"name": lines[1].strip('"'), "version": lines[2].strip('"'), "chainId": int(lines[3].split()[0])}
    t["usdcVersion"] = cast("call", USDC, "version()(string)", "--rpc-url", base).strip('"')
    t["usdcVersionSepolia"] = cast("call", USDC_SEP, "version()(string)", "--rpc-url", sep).strip('"')
    t["usdcVersionAtForkBlock"] = cast("call", USDC, "version()(string)", "--rpc-url", base, "--block", str(fork_block)).strip('"')
    t["permit2CodeBytes"] = code_bytes(PERMIT2, base)

    os.makedirs(os.path.join(ROOT, "results"), exist_ok=True)
    with open(os.path.join(ROOT, "results", "toolchain.json"), "w", encoding="ascii") as f:
        json.dump(t, f, indent=2, ensure_ascii=True)
    print(f"toolchain: forge {t['forge']}; halmos {t['halmos']}; slither {t['slither']}; "
          f"base {t['baseChainId']}, sepolia {t['baseSepoliaChainId']}, forkBlock {fork_block}, "
          f"EP domain {t['entryPointDomain']['name']}/{t['entryPointDomain']['version']}, USDC v{t['usdcVersion']}")


if __name__ == "__main__":
    main()
