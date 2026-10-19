"""Rebuild the callback lists from Twilio WITHOUT losing Franco's own notes.

    set TW_SID / TW_TOK, then:  python -I tools/build-callback-lists.py

The lists are a working document: Franco writes outcomes into the notes
column by hand ("no answer", "shoudlnt call", "find his unicorn first").
A rebuild that wiped those would be worse than never rebuilding, so this
reads the existing files first, lifts every note, and re-attaches it by
phone number. Same lesson as the AD spreadsheet on 2026-10-17 -- never
overwrite a surface a human has been writing on without reading it first.

His notes also carry authority the funnel does not have: a note saying
"shoudlnt call" retires someone the FSM still thinks is a live callback.
"""
import base64
import datetime
import json
import os
import re
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOC_FILE = os.path.join(ROOT, 'docs', 'CALLBACK-HOUSE-OF-CARS.md')
CAP_FILE = os.path.join(ROOT, 'docs', 'CALLBACK-CAPITAL-AND-SAAS.md')
MDT = datetime.timezone(datetime.timedelta(hours=-6))
NOTIFY = '+18257474442'
LINES = {'House of Cars': '15873303601', 'Capital Auto': '15872105135'}
SINCE = '2026-10-15'

# Each of these is a vocabulary a live customer taught us the hard way.
CREDIT = re.compile(
    r"bad credit|poor credit|no credit|my credit|co[- ]?signer|consigner|bankrupt"
    r"|proposal|repo|repossess|surrender|collections|declined|denied|turned down"
    r"|not approve|cant get approve|laid off|lost my job|unemployed|cannot afford"
    r"|no money|no down|financed|scam stuff", re.I)
DECLINE = re.compile(
    r"^(no|nope|nah)\b|not interested|not looking|no longer"
    r"|already (bought|got|found|purchased)|bought (one|a |already)"
    r"|found (one|a car|something)|all set|we have a new car|keep my"
    r"|for the time being|wrong number", re.I)
# "No calls. Text only" was missed by a pattern that only knew "just text".
TEXTONLY = re.compile(r"just text|easier to text|text only|no calls|text me instead", re.I)
# A note from Franco can retire someone the funnel still thinks is live.
# Typed at speed between calls, so match the shape rather than the spelling:
# his actual note read "shoudlnt call", with the l and d transposed, and a
# pattern expecting "shouldnt" walked straight past an instruction not to
# ring a customer. Any sho-word carrying an "nt" near "call" counts, which
# catches shouldnt / shouldn't / shoudlnt while leaving "should call" alone.
NOTE_DNC = re.compile(
    r"\bsho\w*n.?t\b[\s\S]{0,14}\bcall\b|\bsho\w*\s+not\s+call\b"
    r"|do ?n.?t call|do not call|no calls|\bdead\b|not interested", re.I)
MSG_DNC = re.compile(
    r"dont let any one call|do not call|don.t call|we do not need a call"
    r"|get rid of my number|lose my number", re.I)
MONDAY = re.compile(r'\bmonday\b|\bmon\b', re.I)
TIMED = re.compile(r'tomorrow|today|\d|pm|noon', re.I)
NOT_A_TIME = re.compile(r'mercedes|requirements|edmonton', re.I)


def digits(s):
    return re.sub(r'\D', '', s or '')[-10:]


def pretty(ph):
    d = digits(ph)
    return '(%s) %s-%s' % (d[:3], d[3:6], d[6:])


def lift_notes():
    """Pull Franco's notes out of the existing files, keyed by phone.

    Handles both shapes: a dedicated Your-notes column, and the older files
    where he appended after a <br/><br/> inside the last column.
    """
    notes = {}
    for path in (HOC_FILE, CAP_FILE):
        if not os.path.exists(path):
            continue
        header = []
        for line in open(path, encoding='utf-8'):
            if not line.strip().startswith('|'):
                continue
            cells = [c.strip() for c in line.strip().strip('|').split('|')]
            if cells and cells[0] == 'Name':
                header = cells
                continue
            if len(cells) < 5 or set(''.join(cells)) <= set('-: '):
                continue
            ph = digits(cells[1])
            if len(ph) != 10:
                continue
            note = ''
            if 'Your notes' in header:
                idx = header.index('Your notes')
                if idx < len(cells):
                    note = cells[idx].strip()
            if not note:
                parts = re.split(r'<br\s*/?>\s*<br\s*/?>', cells[-1])
                if len(parts) > 1:
                    note = ' '.join(p.strip() for p in parts[1:]).strip()
            if note:
                notes[ph] = note
    return notes


def twilio(sid, auth, query):
    url = ('https://api.twilio.com/2010-04-01/Accounts/%s/Messages.json?%s'
           '&DateSent%%3E=%s&PageSize=1000' % (sid, query, SINCE))
    out, pages = [], 0
    while url and pages < 4:
        req = Request(url, headers={'Authorization': 'Basic ' + auth})
        with urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read().decode())
        out += data.get('messages', [])
        nxt = data.get('next_page_uri')
        url = ('https://api.twilio.com' + nxt) if nxt else None
        pages += 1
    return out


def sent_at(m):
    return datetime.datetime.strptime(
        m['date_created'], '%a, %d %b %Y %H:%M:%S %z').astimezone(MDT)


def collect(sid, auth):
    people = {}
    for book, num in LINES.items():
        out = twilio(sid, auth, 'From=%2B' + num)
        inb = twilio(sid, auth, 'To=%2B' + num)
        for m in out:
            hit = re.match(r'Hi ([^,]{1,28}),', m['body'] or '')
            if hit and m['to'] != NOTIFY:
                people.setdefault(m['to'], {'book': book, 'name': hit.group(1).strip(),
                                            'replies': [], 'asked': None, 'stop': False})
        for m in sorted([x for x in out if x['to'] == NOTIFY], key=lambda x: x['date_created']):
            rows = [x for x in (m['body'] or '').split('\n') if x.strip()]
            ph = next((digits(l) for l in rows if len(digits(l)) == 10), None)
            key = next((k for k in people if digits(k) == ph), None) if ph else None
            if not key:
                continue
            call = next((l.split(':', 1)[1].strip() for l in rows if l.startswith('Call them:')), None)
            if call:
                people[key]['asked'] = call
            elif any('No time given' in l for l in rows) and not people[key]['asked']:
                people[key]['asked'] = '(none given)'
        for m in sorted([x for x in inb if x['from'] != NOTIFY], key=lambda x: x['date_created']):
            body = (m['body'] or '').replace('\n', ' ').strip()
            person = people.setdefault(m['from'], {'book': book, 'name': '?', 'replies': [],
                                                   'asked': None, 'stop': False})
            person['replies'].append((sent_at(m), body))
            if re.match(r'^(stop|unsubscribe)', body, re.I):
                person['stop'] = True
    return people


def window(times):
    hours = sorted({t.hour for t in times})
    order = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    days = sorted({t.strftime('%a') for t in times}, key=order.index)
    if len(hours) > 1:
        band = '%d:00-%d:00' % (min(hours), max(hours) + 1)
    else:
        band = '%02d:00-%02d:00' % (hours[0], hours[0] + 1)
    return '%s %s' % ('/'.join(days), band)


def table(rows):
    if not rows:
        return '*None.*'
    out = ['| Name | Phone | Asked for | Texts you | What they said | Your notes |',
           '|---|---|---|---|---|---|']
    for r in rows:
        tag = ' **TEXT ONLY**' if r['textonly'] else ''
        out.append('| %s%s | %s | %s | **%s** | %s | %s |' % (
            r['name'], tag, pretty(r['phone']), r['asked'][:30], window(r['times']),
            r['said'][:100].replace('|', '/'), r['note'].replace('|', '/')))
    return '\n'.join(out)


def build(book_rows, title, extra=''):
    dnc = [r for r in book_rows if r['dnc']]
    credit = [r for r in book_rows if not r['dnc'] and r['credit']]
    rest = [r for r in book_rows if not r['dnc'] and not r['credit']]
    monday = [r for r in rest if r['monday']]
    overdue = [r for r in rest if not r['monday'] and r['timed']]
    openish = [r for r in rest if not r['monday'] and not r['timed']]
    head = (
        '**Rebuilt %s from the message timestamps.** "Texts you" is the day and hour band they '
        'actually sent from - if they do not pick up when they asked, try that window, because it '
        'is a time they were demonstrably free and holding a phone.\n\n'
        '_Your notes live in their own column and are carried across every rebuild. A note saying '
        '"shouldnt call" moves someone to Do NOT contact._'
        % datetime.datetime.now().strftime('%a %d %b, %H:%M'))
    return ('# %s\n\n%s\n\n%d live leads.\n\n'
            '## Due today (Monday)\n\n%s\n\n'
            '## Overdue - their time has passed, use the reply window\n\n%s\n\n'
            '## No usable time given - use the reply window\n\n%s\n\n'
            '## Credit files - Bromwich conversation, not a car conversation\n\n%s\n\n'
            '## Do NOT contact\n\n%s\n%s'
            % (title, head, len(book_rows), table(monday), table(overdue),
               table(openish), table(credit), table(dnc), extra))


SAAS = ('\n## SaaS prospect - First Fin itself\n\n'
        '| Name | Phone | Source | Status | Notes |\n|---|---|---|---|---|\n'
        '| Gaurav Raval | (780) 802-4540 | facebook | contacted | Filled the ad **Sun 11:58am**. '
        'Called Mon morning, sounded asleep, texted. Awake and filling forms Sunday midday, so '
        '**late morning** beats early. First new inquiry since Sep 22. |\n')


def main():
    sid, tok = os.environ['TW_SID'], os.environ['TW_TOK']
    auth = base64.b64encode((sid + ':' + tok).encode()).decode()
    notes = lift_notes()
    people = collect(sid, auth)

    rows = []
    for ph, p in people.items():
        if p['stop'] or not p['replies']:
            continue
        said = ' // '.join(b for _, b in p['replies'])
        note = notes.get(digits(ph), '')
        booked = p['asked'] is not None
        credit = bool(CREDIT.search(said))
        if not booked and not credit:
            continue
        if DECLINE.match(said.strip()) and not booked and not credit:
            continue
        rows.append({
            'phone': ph, 'name': p['name'], 'book': p['book'], 'asked': p['asked'] or '-',
            'times': [t for t, _ in p['replies']], 'said': said, 'note': note, 'credit': credit,
            'textonly': bool(TEXTONLY.search(said)),
            'dnc': bool(MSG_DNC.search(said)) or bool(note and NOTE_DNC.search(note)),
            'monday': bool(MONDAY.search((p['asked'] or '') + ' ' + said)),
            'timed': bool(TIMED.search(p['asked'] or '')) and not NOT_A_TIME.search(p['asked'] or ''),
        })
    rows.sort(key=lambda r: (r['name'] or '').lower())

    hoc = [r for r in rows if r['book'] == 'House of Cars']
    cap = [r for r in rows if r['book'] == 'Capital Auto']
    open(HOC_FILE, 'w', encoding='utf-8').write(
        build(hoc, 'House of Cars - callback / text-back list'))
    open(CAP_FILE, 'w', encoding='utf-8').write(
        build(cap, 'Capital Auto Finance + SaaS - callback / text-back list', SAAS))

    print('House of Cars %d | Capital Auto %d | notes carried %d of %d'
          % (len(hoc), len(cap), sum(1 for r in rows if r['note']), len(notes)))
    by_note = [r['name'] for r in rows if r['dnc'] and not MSG_DNC.search(r['said'])]
    if by_note:
        print('retired by your own note:', ', '.join(by_note))
    tonly = [r['name'] for r in rows if r['textonly']]
    print('text only:', ', '.join(tonly) if tonly else 'none')
    missing = [ph for ph in notes if not any(digits(r['phone']) == ph for r in rows)]
    if missing:
        print('WARNING - notes with no matching row (not written out):', missing)


if __name__ == '__main__':
    main()
