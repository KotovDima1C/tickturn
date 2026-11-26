"""Move tickturn 0.4/0.5 statistics into the 0.6 history files.

0.4.0 and 0.5.0 kept day totals per session in ~/.claude/tickturn/sessions/<month>/<id>.json.
0.6.0 keeps every session's requests in ~/.claude/tickturn/history/<id>.json and counts
days from them. For each old session file this script rebuilds the session's requests
from Claude Code's own transcript (~/.claude/projects/*/<id>.jsonl and its subagents):
text, duration, tokens and cost priced at API rates. A session without a transcript
keeps its day totals as `before`. The old folders are then moved to legacy/.

    python tools/migrate_legacy.py            # compare only, change nothing
    python tools/migrate_legacy.py --apply    # write history/ and move the old folders

Safe to run again: a session is rebuilt from its transcript each time.
"""

import glob
import json
import os
import shutil
import sys
from datetime import datetime

HOME = os.path.expanduser('~')
DIR = os.path.join(HOME, '.claude', 'tickturn')
PROJECTS = os.path.join(HOME, '.claude', 'projects')
TEXT_CHARS = 100

# US dollars per million tokens: input, output, cache read, cache write 5m, cache write 1h.
PRICES = {
    'claude-opus-5-5': (4, 20, 0.2, 5, 8),
    'claude-fable-5-2': (8, 40, 0.2, 10, 16),
}
INTERRUPTED = '[Request interrupted by user'


def ms(stamp):
    return int(datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000)


def day_of(epoch_ms):
    return datetime.fromtimestamp(epoch_ms / 1000).strftime('%Y-%m-%d')


def lines(path):
    with open(path, encoding='utf-8') as f:
        for line in f:
            try:
                yield json.loads(line)
            except ValueError:
                continue


def prompt_text(entry):
    """The text of a message that starts a turn (a person's prompt, a message from another
    session, a background event), or None when the entry is not one."""
    if entry.get('type') != 'user' or entry.get('isSidechain') or entry.get('isCompactSummary'):
        return None
    if entry.get('isMeta') and not isinstance(entry.get('origin'), dict):
        return None  # skill text, image paths and other additions to a prompt
    content = entry.get('message', {}).get('content')
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        if any(block.get('type') == 'tool_result' for block in content):
            return None
        return ' '.join(block.get('text', '') for block in content if block.get('type') == 'text')
    return None


unknown_models = set()


def priced(message):
    """Tokens and cost of one API response."""
    usage = message.get('usage') or {}
    write = usage.get('cache_creation') or {}
    w5 = write.get('ephemeral_5m_input_tokens', 0)
    w1 = write.get('ephemeral_1h_input_tokens', 0)
    total_write = usage.get('cache_creation_input_tokens', 0)
    if w5 + w1 != total_write:
        w5 = total_write - w1
    tokens = {
        'input': usage.get('input_tokens', 0),
        'output': usage.get('output_tokens', 0),
        'cacheRead': usage.get('cache_read_input_tokens', 0),
        'cacheWrite': total_write,
    }
    rates = PRICES.get(message.get('model'))
    if rates is None:
        unknown_models.add(message.get('model'))
        return tokens, 0.0
    usd = (tokens['input'] * rates[0] + tokens['output'] * rates[1] + tokens['cacheRead'] * rates[2]
           + w5 * rates[3] + w1 * rates[4]) / 1e6
    return tokens, usd


def responses(path):
    """Each API response in a transcript once, with its time: (ms, message)."""
    seen = set()
    for entry in lines(path):
        if entry.get('type') != 'assistant' or 'timestamp' not in entry:
            continue
        message = entry.get('message') or {}
        key = message.get('id') or entry.get('uuid')
        if key in seen or not message.get('usage'):
            continue
        seen.add(key)
        yield ms(entry['timestamp']), message


def rebuild(transcript):
    """A session's turns from its transcript, subagents' responses counted in the turn they ran in."""
    starts = []  # (ms, id, text)
    last_seen = []  # time of the last entry before the next prompt
    interrupted = set()
    for entry in lines(transcript):
        if 'timestamp' not in entry or entry.get('isSidechain'):
            continue
        at = ms(entry['timestamp'])
        text = prompt_text(entry)
        if text is not None and INTERRUPTED in text:
            if starts:
                interrupted.add(len(starts) - 1)
            continue
        if text is not None:
            starts.append((at, entry.get('uuid'), text))
            last_seen.append(at)
        elif starts and (entry.get('type') == 'assistant' or entry.get('type') == 'user'):
            last_seen[-1] = max(last_seen[-1], at)  # the turn's own responses and tool results

    turns = [{'tokens': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'usd': 0.0, 'calls': 0}
             for _ in starts]
    sources = [transcript] + glob.glob(os.path.join(transcript[:-len('.jsonl')], 'subagents', '*.jsonl'))
    for source in sources:
        for at, message in responses(source):
            index = None
            for i, (start, _, _) in enumerate(starts):
                if start <= at:
                    index = i
                else:
                    break
            if index is None:
                continue
            tokens, usd = priced(message)
            turn = turns[index]
            for key in tokens:
                turn['tokens'][key] += tokens[key]
            turn['usd'] += usd
            turn['calls'] += 1
            if source != transcript:
                last_seen[index] = max(last_seen[index], at)

    records = []
    for i, (start, uid, text) in enumerate(starts):
        if turns[i]['calls'] == 0:
            continue  # a local command, nothing went to the API
        records.append({
            'id': uid,
            'text': ''.join(list(text.strip())[:TEXT_CHARS]),
            'seconds': round((last_seen[i] - start) / 1000),
            'reason': 'aborted' if i in interrupted else 'answer',
            'endedAt': last_seen[i],
            'tokens': turns[i]['tokens'],
            'usd': turns[i]['usd'],
        })
    return records


def days_of(turns, before=None):
    days = {k: dict(v) for k, v in (before or {}).items()}
    for turn in turns:
        day = days.setdefault(day_of(turn['endedAt']), {'usd': 0.0, 'requests': 0, 'seconds': 0})
        day['usd'] += turn.get('usd', 0)
        day['requests'] += 1
        day['seconds'] += turn['seconds']
    return days


def find_transcript(session_id):
    found = glob.glob(os.path.join(PROJECTS, '*', session_id + '.jsonl'))
    return found[0] if found else None


def main(apply):
    legacy = {}
    for path in glob.glob(os.path.join(DIR, 'sessions', '*', '*.json')):
        session_id = os.path.basename(path)[:-len('.json')]
        days = json.load(open(path, encoding='utf-8')).get('days', {})
        for day, totals in days.items():
            into = legacy.setdefault(session_id, {}).setdefault(day, {'usd': 0.0, 'requests': 0, 'seconds': 0})
            for key in into:
                into[key] += totals.get(key, 0)
    if not legacy:
        print('No old session files: nothing to move.')
        return

    out = {}
    print(f'{"session":<10} {"day":<10} {"old $":>8} {"new $":>8} {"old req":>7} {"new req":>7} {"old time":>8} {"new time":>8}')
    for session_id, old_days in sorted(legacy.items()):
        transcript = find_transcript(session_id)
        if transcript:
            turns = rebuild(transcript)
            body = {'turns': turns, 'tokens': {k: sum(t['tokens'][k] for t in turns)
                                               for k in ('input', 'output', 'cacheRead', 'cacheWrite')}}
        else:
            body = {'turns': [], 'tokens': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
                    'before': old_days}
        out[session_id] = body
        new_days = days_of(body['turns'], body.get('before'))
        for day in sorted(set(old_days) | set(new_days)):
            o = old_days.get(day, {'usd': 0, 'requests': 0, 'seconds': 0})
            n = new_days.get(day, {'usd': 0, 'requests': 0, 'seconds': 0})
            print(f'{session_id[:8]:<10} {day:<10} {o["usd"]:>8.2f} {n["usd"]:>8.2f} {o["requests"]:>7} '
                  f'{n["requests"]:>7} {o["seconds"]:>8} {n["seconds"]:>8}{"" if transcript else "  (no transcript)"}')

    if unknown_models:
        print('Models with no price, counted at $0:', ', '.join(sorted(map(str, unknown_models))))
    if not apply:
        print('\nCompare only. Run with --apply to write history/ and move the old folders to legacy/.')
        return

    os.makedirs(os.path.join(DIR, 'history'), exist_ok=True)
    for session_id, body in out.items():
        with open(os.path.join(DIR, 'history', session_id + '.json'), 'w', encoding='utf-8') as f:
            json.dump(body, f, ensure_ascii=False)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    for name in ('sessions', 'months'):
        if os.path.isdir(os.path.join(DIR, name)):
            shutil.move(os.path.join(DIR, name), os.path.join(DIR, 'legacy', stamp, name))
    print(f'\nWrote {len(out)} history files; old folders are in legacy/{stamp}/.')


if __name__ == '__main__':
    main('--apply' in sys.argv)
