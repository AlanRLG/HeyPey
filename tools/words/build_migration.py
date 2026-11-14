#!/usr/bin/env python3
"""Genera backend/supabase/migrations/0005_seed_words.sql y seed/secret_words.csv
desde data/words/secret_words.csv (fuente única, columnas word,spoken).

Uso: python3 tools/words/build_migration.py
"""
import csv
import pathlib
import shutil
import sys

root = pathlib.Path(__file__).resolve().parents[2]
src = root / "data/words/secret_words.csv"
rows = list(csv.DictReader(src.open(encoding="utf-8")))
words = [r["word"].strip() for r in rows]
if len(set(words)) != len(words):
    sys.exit("palabras duplicadas en el CSV")
if len(rows) < 300:
    sys.exit(f"se necesitan >= 300 palabras; hay {len(rows)}")
for r in rows:
    if "'" in r["word"] + r["spoken"]:
        sys.exit(f"comilla no permitida: {r}")

shutil.copy(src, root / "backend/supabase/seed/secret_words.csv")
values = ",\n".join(f"  ('{r['word'].strip()}', '{r['spoken'].strip()}')" for r in rows)
(root / "backend/supabase/migrations/0005_seed_words.sql").write_text(
    "-- 0005_seed_words.sql: generado desde data/words/secret_words.csv (tools/words/build_migration.py).\n"
    "-- [VERIFICAR] cada palabra con el ASR y el TTS; retirar pares que suenen parecido (active = false).\n"
    "insert into secret_words (word, spoken) values\n" + values + "\non conflict (word) do nothing;\n",
    encoding="utf-8",
)
print(f"{len(rows)} palabras")
