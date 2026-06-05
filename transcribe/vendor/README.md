# Vendored DS2/DSS decoder

These files are vendored from **[hirparak/dss-codec](https://github.com/hirparak/dss-codec)**
(MIT License, Copyright (c) 2026 Kieran Hirpara) — the open-source reverse
engineering of the Olympus DS2/DSS codec.

```
ds2decode.py          DS2 SP/QP decoder
dss_decode.py         DSS SP decoder
ds2_lsp_codebook.npz  SP reflection-coefficient codebook
ds2_qp_codebook.npz   QP reflection-coefficient codebook
```

## Local patches

Each `.py` file carries small, clearly-marked `# PATCH (ds2-converter)` edits so
re-vendoring a newer upstream version stays easy:

1. **Script-relative codebooks** (`ds2decode.py:load_codebook`) — resolve bare
   `*.npz` filenames against this directory so the decoder works from any cwd.
2. **DMA-preamble tolerance** (`_strip_preamble` in both files) — skip the 1–2
   uninitialized bytes some Olympus DS-5000 firmware writes before the magic.
   Mirrors `cli/convert.mjs:stripPreamble`.

No decoding logic was changed; output is byte-identical to upstream on clean files.
