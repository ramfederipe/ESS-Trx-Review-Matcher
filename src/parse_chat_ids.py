import json
import re
import sys

import pandas as pd


def clean(value):
    if pd.isna(value):
        return ""
    text = str(value).strip()
    if text.endswith(".0") and re.fullmatch(r"-?\d+\.0", text):
        text = text[:-2]
    return text


def normalize_header(value):
    return re.sub(r"[^a-z0-9]+", "", clean(value).lower())


def pick_columns(frame):
    headers = [normalize_header(column) for column in frame.columns]
    agent_index = next((index for index, header in enumerate(headers) if header in {"agent", "agentname", "agentkey", "name"}), None)
    chat_index = next((index for index, header in enumerate(headers) if header in {"chatid", "telegramchatid", "tgchatid", "chat"}), None)
    if agent_index is not None and chat_index is not None:
        return agent_index, chat_index, frame

    raw = pd.read_excel(sys.argv[1], header=None, dtype=str) if sys.argv[1].lower().endswith((".xlsx", ".xlsm")) else pd.read_csv(sys.argv[1], header=None, dtype=str)
    return 0, 1, raw


def read_file(file_path):
    lower = file_path.lower()
    if lower.endswith((".xlsx", ".xlsm")):
        return pd.read_excel(file_path, dtype=str)
    if lower.endswith(".csv"):
        return pd.read_csv(file_path, dtype=str)
    if lower.endswith(".tsv"):
        return pd.read_csv(file_path, sep="\t", dtype=str)
    raise ValueError("Only .xlsx, .xlsm, .csv, and .tsv files are supported")


def main():
    if len(sys.argv) < 2:
        raise ValueError("File path is required")
    file_path = sys.argv[1]
    frame = read_file(file_path)
    agent_index, chat_index, rows = pick_columns(frame)
    lines = []
    skipped = 0
    for _, row in rows.iterrows():
        values = list(row)
        if len(values) <= max(agent_index, chat_index):
            skipped += 1
            continue
        agent = clean(values[agent_index])
        chat_id = clean(values[chat_index])
        if not agent or not re.fullmatch(r"-?\d{5,}", chat_id):
            skipped += 1
            continue
        lines.append(f"{agent} {chat_id}")
    print(json.dumps({"text": "\n".join(lines), "rows": len(lines), "skipped": skipped}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
