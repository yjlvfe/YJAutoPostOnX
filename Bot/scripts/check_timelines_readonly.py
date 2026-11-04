#!/usr/bin/env python3
"""Read-only timeline check for ambiguous items against real X timelines.
Does not write to SQLite, does not post, does not mutate accounts.
"""
import asyncio
import json
import os
from pathlib import Path
import sys

BOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BOT_DIR / 'python'))

from direct_x_bridge import new_client, read_cookies, DirectSession, normalize_text_for_comparison, username

ACCOUNTS_MAP = [
    {'slot': 1, 'id': 'x-ab22678a0fc05660b440', 'username': 'emiehg', 'userId': '2114825043343511553'},
    {'slot': 2, 'id': 'x-930e0054b395228aefa9', 'username': 'crytpokingxvo8', 'userId': '2112766385252192256'},
    {'slot': 3, 'id': 'x-86ef47c7166eaeb29e1a', 'username': 'kaniabq', 'userId': '2116977848040792064'},
    {'slot': 4, 'id': 'x-a55ef01cbf656b2e7410', 'username': 'marcosvhv', 'userId': '2116982313443581953'},
    {'slot': 5, 'id': 'x-23d02ee683cbc043ff16', 'username': 'menalobq', 'userId': '2116986514341027840'},
]

async def check_account_timeline(acc, ambiguous_items):
    proxy = f"socks5h://127.0.0.1:1880{acc['slot']}"
    cookie_path = BOT_DIR / 'data' / 'cookies' / f"{acc['id']}.cookies"
    if not cookie_path.exists():
        print(f"[{acc['username']}] Cookie file not found: {cookie_path}")
        return []

    print(f"\n[{acc['username']}] Connecting via {proxy}...")
    cookies = read_cookies(str(cookie_path))
    client = new_client(proxy)
    client.set_cookies(cookies, clear_cookies=True)
    session = DirectSession(client, acc)
    
    try:
        identity = await session.identity()
        print(f"[{acc['username']}] Identity confirmed: userId={identity['userId']}, username={identity['username']}")
        user_id = str(identity['userId'])
        
        # Fetch timeline tweets
        all_tweets = []
        cursor = None
        for page in range(3):  # up to 3 pages
            print(f"[{acc['username']}] Fetching user_tweets page {page+1} (cursor={cursor})...")
            gql_res, _ = await asyncio.wait_for(
                client.gql.user_tweets(user_id, 20, cursor),
                timeout=15
            )
            if not isinstance(gql_res, dict) or gql_res.get('errors'):
                print(f"[{acc['username']}] GQL response had errors or not dict: {gql_res.get('errors') if isinstance(gql_res, dict) else type(gql_res)}")
                break
            
            instructions = (
                gql_res.get('data', {})
                .get('user', {})
                .get('result', {})
                .get('timeline_v2', {})
                .get('timeline', {})
                .get('instructions', [])
            )
            next_cursor = None
            page_tweets = 0
            for instr in instructions:
                if not isinstance(instr, dict): continue
                for entry in instr.get('entries', []):
                    if not isinstance(entry, dict): continue
                    content = entry.get('content', {})
                    entry_id = str(entry.get('entryId', ''))
                    if 'cursor' in entry_id.lower() or content.get('cursorType') in ('Bottom', 'bottom'):
                        val = content.get('value')
                        if isinstance(val, str) and val.strip():
                            next_cursor = val.strip()
                    item_content = content.get('itemContent', {})
                    tw_results = item_content.get('tweet_results', {}).get('result', {})
                    if isinstance(tw_results, dict):
                        tw = tw_results.get('tweet', tw_results) if isinstance(tw_results.get('tweet'), dict) else tw_results
                        legacy = tw.get('legacy', {}) if isinstance(tw.get('legacy'), dict) else {}
                        tid = legacy.get('id_str')
                        full_text = legacy.get('full_text', '')
                        if tid and full_text:
                            all_tweets.append({
                                'id': tid,
                                'url': f"https://x.com/{identity['username']}/status/{tid}",
                                'text': full_text,
                                'created_at': legacy.get('created_at'),
                                'entities': legacy.get('entities')
                            })
                            page_tweets += 1
            print(f"[{acc['username']}] Page {page+1} found {page_tweets} tweets.")
            cursor = next_cursor
            if not cursor or page_tweets == 0:
                break
            await asyncio.sleep(1)
        
        print(f"[{acc['username']}] Total tweets fetched: {len(all_tweets)}")
        
        # Now compare against ambiguous items
        matches = []
        for item in ambiguous_items:
            target_text = item.get('text', '')
            norm_target = normalize_text_for_comparison(target_text)
            for tw in all_tweets:
                norm_tw = normalize_text_for_comparison(tw['text'], tw.get('entities'))
                if (norm_target and norm_tw and norm_target == norm_tw) or (target_text.strip() == tw['text'].strip()):
                    match_record = {
                        'itemId': item['itemId'],
                        'tweetId': tw['id'],
                        'url': tw['url'],
                        'account': acc['username'],
                        'createdAt': tw['created_at'],
                        'text': tw['text'][:100]
                    }
                    matches.append(match_record)
                    print(f"  >>> MATCH FOUND for ambiguous item {item['itemId']}! URL: {tw['url']}")
        return matches
    except Exception as e:
        print(f"[{acc['username']}] Error during timeline check: {e}")
        return []
    finally:
        try:
            await client.http.aclose()
        except Exception:
            pass

async def main():
    inv_path = BOT_DIR / 'Reports' / 'audit_ambiguous_m11.json'
    inv = json.loads(inv_path.read_text(encoding='utf-8'))
    
    # Load state to get texts
    state_path = BOT_DIR / 'data' / 'state.sqlite'
    import sqlite3
    conn = sqlite3.connect(str(state_path))
    cur = conn.cursor()
    cur.execute("SELECT json FROM state WHERE id = 1")
    state = json.loads(cur.fetchone()[0])
    conn.close()
    
    items_by_id = {i['id']: i for i in state.get('items', [])}
    ambiguous_items = []
    for it in inv.get('items', []):
        iid = it['itemId']
        db_it = items_by_id.get(iid)
        text = db_it.get('payload', {}).get('text', '') if db_it else ''
        ambiguous_items.append({'itemId': iid, 'text': text})
    
    print(f"Loaded {len(ambiguous_items)} ambiguous items to cross-reference.")
    
    all_matches = []
    for acc in ACCOUNTS_MAP:
        matches = await check_account_timeline(acc, ambiguous_items)
        all_matches.extend(matches)
        await asyncio.sleep(2)
        
    print(f"\n==========================================")
    print(f"FINAL TIMELINE AUDIT RESULT:")
    print(f"Total confirmed published on X: {len(all_matches)} / {len(ambiguous_items)}")
    for m in all_matches:
        print(f"  Item {m['itemId']} -> {m['url']} (@{m['account']})")
    
    out_file = Path(os.environ.get('TIMELINE_AUDIT_OUTPUT', '/tmp/yj_timeline_audit_results.json'))
    out_file.write_text(json.dumps(all_matches, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f"Saved results to {out_file}")

if __name__ == '__main__':
    asyncio.run(main())
