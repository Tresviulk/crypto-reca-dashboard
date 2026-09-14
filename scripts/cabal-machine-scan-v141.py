#!/usr/bin/env python3
"""CABAL v1.4.1 hygiene wrapper.

Runs the v1.4 FIL anti-miss scanner but removes tokenized equities / xStocks from
CoinGecko discovery before eligibility and ranking. These instruments can exhibit
exchange-specific turnover/RVOL patterns that are not crypto accumulation signals.
"""
import importlib.util
from pathlib import Path

BASE = Path(__file__).with_name('cabal-machine-scan-v14.py')
spec = importlib.util.spec_from_file_location('cabal_v14', BASE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

_orig_get = mod.get

NON_CRYPTO_NAME_MARKERS = (
    'xstock',
    'tokenized stock',
    'tokenised stock',
    'tokenized equity',
    'tokenised equity',
    'tokenized etf',
    'tokenised etf',
    'ondo tokenized stock',
    'ondo tokenised stock',
)

def _is_tokenized_equity(m):
    name = str(m.get('name') or '').lower()
    return any(marker in name for marker in NON_CRYPTO_NAME_MARKERS)

def filtered_get(url, timeout=20, retries=2):
    data = _orig_get(url, timeout, retries)
    if 'api.coingecko.com/api/v3/coins/markets' in url and isinstance(data, list):
        return [m for m in data if isinstance(m, dict) and not _is_tokenized_equity(m)]
    return data

mod.get = filtered_get
mod.SCHEMA = '1.4.1'
mod.UA = 'CABAL-Discovery-Guard/1.4.1'

if __name__ == '__main__':
    mod.main()
