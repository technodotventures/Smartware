"""Read-only board query: recent smartware cards, to avoid duplicating an existing follow-up card."""
import sqlite3
import sys

DB = "/opt/data/kanban/boards/smartware/kanban.db"
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
cur = con.cursor()

needles = [n.lower() for n in sys.argv[1:]] or [""]
rows = cur.execute(
    "select id, status, assignee, substr(title,1,150), substr(coalesce(result,''),1,0) from tasks "
    "order by created_at desc limit 400"
).fetchall()
seen = 0
for tid, status, assignee, title, _ in rows:
    hay = f"{tid} {status} {assignee} {title}".lower()
    if any(n in hay for n in needles):
        print(f"{tid}  {status:9} {str(assignee):14} {title}")
        seen += 1
print(f"--- {seen} matches of {len(rows)} cards (newest 400) ---")
con.close()
