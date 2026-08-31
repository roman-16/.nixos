#!/usr/bin/env python3
"""Watch supermarket products and report the offers running on them.

Owns storage, the provider calls, all date arithmetic, and output rendering, so none of it
is ever done in-model. JSON lives under offers/ in the workspace, found from there wherever
this is run from, and must only ever be changed through this script.

The digest goes out inside the daily briefing, sent by a timer with no agent in the loop,
which is why the postcode lives in config.json here rather than in the agent's MEMORY.md: the
script that needs it can read this file, and cannot read that one.

Offers come from marktguru. That is an implementation detail of the provider section below
and never appears in what the user reads; everything outside that section deals in plain
offers, so a second source would only add another provider.
"""

from __future__ import annotations

import argparse
import difflib
import io
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from contextlib import redirect_stdout
from datetime import datetime
from pathlib import Path
from typing import NamedTuple
from zoneinfo import ZoneInfo

# Anchored to the workspace rather than the working directory, because where this script is run from
# says nothing about where the user's watches are - and a watchlist looked for in the wrong place
# reads exactly like a watchlist with nothing in it.
WORKSPACE = Path(os.environ.get("APOLLO_WORKSPACE") or Path.home() / "workspace")
OFFERS_DIR = WORKSPACE / "offers"
CONFIG_FILE = OFFERS_DIR / "config.json"
WATCH_FILE = OFFERS_DIR / "watchlist.json"

# The user's timezone, named explicitly rather than taken from the host: every date the user
# reads is derived from a UTC timestamp, so the conversion must not depend on where this runs.
TZ = ZoneInfo("Europe/Vienna")

# How many deals per watch are worth reading, per section (running now, and upcoming).
CAP = 4

# The trade the provider files wholesalers under. Their prices exclude VAT.
WHOLESALE_INDUSTRY = 6

# Conditions attached to a price, marked on the line rather than explained in it.
NET_MARK = "\U0001f9fe"  # net of VAT, the till adds it
CARD_MARK = "\U0001f4b3"  # needs the shop's loyalty card

# Score below which difflib stops proposing a fuzzy name match (0..1).
FUZZY_CUTOFF = 0.6

# How many brands a query may match before the watch counts as too broad to be useful.
BROAD_BRANDS = 4


def die(msg: str):
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


# Notes addressed to the caller rather than the user. What gets delivered is the command's printed
# result, so these are collected during the run and written after it, outside that buffer.
NOTES: list = []


def hint(msg: str):
    """Tell the caller something the user has no reason to read."""
    NOTES.append(msg)


# --- storage -------------------------------------------------------------


def load(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def save(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def zip_code() -> str:
    code = load(CONFIG_FILE, {}).get("zipCode")
    if not code:
        die("no postcode set yet - ask the user for theirs once, then: offers.py config-set --zip 4020")
    return str(code)


def id_list(value: str | None) -> list:
    """Parse a comma-separated list of provider ids."""
    if not value:
        return []
    out = []
    for part in value.replace(",", " ").split():
        if not part.isdigit():
            raise argparse.ArgumentTypeError(f'not an id: "{part}"')
        out.append(int(part))
    return out


# --- watch resolution ----------------------------------------------------


def labels_of(key: str, watch: dict) -> set:
    return {key.lower(), watch.get("label", "").lower()}


def find_watch(watchlist: dict, query: str) -> tuple:
    """Resolve a watch reference by a confidence ladder - exact, then unique substring, then a
    fuzzy match - and never silently pick a winner when several candidates tie. Returns
    (key, watch, assumed_label)."""
    q = (query or "").lower().strip()
    if not q:
        die("give a watch name")
    for key, watch in watchlist.items():
        if q in labels_of(key, watch):
            return key, watch, None
    subs = [(k, w) for k, w in watchlist.items() if any(q in label for label in labels_of(k, w))]
    if len(subs) == 1:
        return subs[0][0], subs[0][1], None
    if subs:
        die(f'"{query}" matches several watches: {", ".join(w["label"] for _, w in subs)}. Be more specific.')
    pool = {}
    for key, watch in watchlist.items():
        for label in labels_of(key, watch):
            pool.setdefault(label, (key, watch))
    close = difflib.get_close_matches(q, list(pool), n=3, cutoff=FUZZY_CUTOFF)
    if len(close) == 1:
        key, watch = pool[close[0]]
        return key, watch, watch["label"]
    if close:
        names = ", ".join(dict.fromkeys(pool[c][1]["label"] for c in close))
        die(f'no exact match for "{query}" - did you mean: {names}?')
    die(f'no watch matches "{query}" - check watch-list.')


# --- provider: marktguru -------------------------------------------------
# Everything specific to where offers come from lives here. The rest of the script only uses
# search() and leaflet_url(), and speaks of offers rather than of any particular platform.

WEB = "https://www.marktguru.at"
API = "https://api.marktguru.at/api/v1"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
SEARCH_LIMIT = 100
FLIGHT_LIMIT = 300
TIMEOUT = 20


class Provider:
    """Talks to the offer API. Holds the credential and the per-run lookup caches, so a digest
    over several watches resolves shared leaflets once."""

    def __init__(self):
        self._key: str | None = None
        self._main_leaflet: dict | None = None
        self._pages: dict = {}

    # The web client's key is published in the homepage's embedded config and rotates, so it is
    # read from there rather than stored. A rotation surfaces as a 401, which api() retries once.
    def key(self, *, refresh: bool = False) -> str:
        if self._key is None or refresh:
            html = self._get(f"{WEB}/").decode("utf-8", "replace")
            match = re.search(r'"apiKey"\s*:\s*"([^"]+)"', html)
            if not match:
                die("could not read the offer API key from the provider's homepage")
            self._key = match.group(1)
        return self._key

    def _get(self, url: str, headers: dict | None = None) -> bytes:
        request = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.read()

    def api(self, path: str, *, missing_ok: bool = False, **params):
        """The parsed response, or None when `missing_ok` and no such record exists."""
        url = f"{API}/{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        for attempt in (0, 1):
            headers = {"x-apikey": self.key(refresh=attempt == 1), "Accept": "application/json"}
            try:
                return json.loads(self._get(url, headers))
            except urllib.error.HTTPError as error:
                if error.code == 401 and attempt == 0:
                    continue  # the key rotated; re-read it and retry once
                if error.code == 404 and missing_ok:
                    return None
                die(f"offer provider returned {error.code} for {path}")
            except urllib.error.URLError as error:
                die(f"could not reach the offer provider: {error.reason}")
        return {}

    def _query(self, watch: dict, code: str, limit: int) -> dict:
        params = {"as": "web", "q": watch["query"], "zipCode": code, "limit": limit}
        if watch.get("brands"):
            params["brands"] = ",".join(map(str, watch["brands"]))
        if watch.get("retailers"):
            params["retailers"] = ",".join(map(str, watch["retailers"]))
        return self.api("offers/search", **params) or {}

    def search(self, watch: dict, code: str) -> list:
        """Offers currently listed for a watch. Expired ones are already excluded upstream;
        upcoming ones are included on purpose, so a deal is known before it starts."""
        return self._query(watch, code, SEARCH_LIMIT).get("results") or []

    def facets(self, watch: dict, code: str) -> dict:
        return self._query(watch, code, 1).get("filters") or {}

    def survey(self, watch: dict, code: str) -> tuple:
        """(offers, facets) from a single call - what a watch has now, and what else its query
        matches, which is how a too-broad watch is spotted at the moment it is created."""
        data = self._query(watch, code, SEARCH_LIMIT)
        return (data.get("results") or [], data.get("filters") or {})

    def name_of(self, kind: str, ident) -> str | None:
        """The name behind a brand or retailer id, or None when the id does not exist. Checking a
        pin when it is set is what keeps silence trustworthy: a mistyped id would otherwise look
        exactly like a product that simply never goes on offer."""
        record = self.api(f"{kind}/{ident}", missing_ok=True)
        return (record or {}).get("name")

    # An offer names the leaflet *flight* it came from, not the leaflet, and the page it sits on
    # is recorded on the leaflet. So a deep link is two lookups: flight -> main leaflet, then
    # that leaflet's children -> page index. Both are cached for the run.
    def _leaflet_of(self, flight_id, code: str):
        if self._main_leaflet is None:
            flights = (self.api("leafletFlights", zipCode=code, limit=FLIGHT_LIMIT) or {}).get("results") or []
            self._main_leaflet = {f["id"]: f["mainLeafletId"] for f in flights if f.get("mainLeafletId")}
        return self._main_leaflet.get(flight_id)

    def _page_of(self, leaflet_id, offer_id):
        if leaflet_id not in self._pages:
            children = (self.api(f"leaflets/{leaflet_id}") or {}).get("children") or []
            self._pages[leaflet_id] = {
                child["id"].split("/")[-1]: child.get("pageIndex")
                for child in children
                if child.get("id")
            }
        return self._pages[leaflet_id].get(str(offer_id))

    def leaflet_url(self, offer: dict, code: str) -> str | None:
        leaflet_id = self._leaflet_of(offer.get("leafletFlightId"), code)
        if not leaflet_id:
            return None
        page = self._page_of(leaflet_id, offer["id"])
        return f"{WEB}/leaflets/{leaflet_id}/page/{page}" if page is not None else f"{WEB}/leaflets/{leaflet_id}"


# --- rendering -----------------------------------------------------------


def local(timestamp: str) -> datetime:
    """A provider timestamp as the user's wall clock. The provider stores UTC, and a window
    opening at 22:00Z is midnight the following day here - so slicing the date off the string
    would report every start date a day early."""
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).astimezone(TZ)


def day(moment: datetime) -> str:
    return f"{moment:%a %d.%m}"


def money(value) -> str:
    return f"{value:.2f}"


def unit_of(offer: dict) -> str:
    return (offer.get("unit") or {}).get("shortName") or ""


def shops_of(offers: list) -> list:
    return sorted({o["advertisers"][0]["name"] for o in offers if o.get("advertisers")})


def is_trade(offer: dict) -> bool:
    """Whether an offer's price excludes VAT. Wholesalers quote net, so their prices are not what
    you hand over at the till. The trade is named in the offer itself, which is why this needs no
    list of retailers to maintain - and why it must not be one: SPAR-Gourmet is an ordinary
    supermarket, Transgourmet is a wholesaler, and no amount of name matching tells them apart.
    An offer that names no trade at all is taken at face value."""
    return any(industry.get("id") == WHOLESALE_INDUSTRY for industry in offer.get("industries") or [])


class Deal(NamedTuple):
    """One price running at one time, however many shops carry it."""

    price: float
    starts: datetime
    ends: datetime
    reference: float
    unit: str
    trade: bool
    offers: list


def group_offers(offers: list) -> list:
    """Collapse offers that are the same deal into one Deal. A price running at the same time
    across a retail group is one thing the user needs to know, not six; the shops are listed
    instead. A net price and a gross price are never the same deal even at the same number, so
    the tax basis is part of what makes a deal itself."""
    groups: dict = {}
    for offer in offers:
        windows = offer.get("validityDates") or []
        if not windows or offer.get("price") is None:
            continue
        starts, ends = local(windows[0]["from"]), local(windows[0]["to"])
        key = (offer["price"], starts.date(), ends.date(),
               round(offer.get("referencePrice") or 0, 2), unit_of(offer), is_trade(offer))
        groups.setdefault(key, (starts, ends, []))[2].append(offer)
    return [
        Deal(price, starts, ends, reference, unit, trade, items)
        for (price, _sd, _ed, reference, unit, trade), (starts, ends, items) in groups.items()
    ]


def unit_order(deals: list) -> dict:
    """Rank of each unit for a watch, commonest first. A price per unit only means something
    against the same unit - 0.22/Stk is not dearer than 0.99/l, it is a different measurement -
    so deals are ordered by unit before they are ordered by value. A watch pinned to one brand
    has a single unit, which is why this is invisible in the common case."""
    counts: dict = {}
    for deal in deals:
        counts[deal.unit] = counts.get(deal.unit, 0) + 1
    ranked = sorted((unit for unit in counts if unit), key=lambda unit: (-counts[unit], unit))
    order = {unit: rank for rank, unit in enumerate(ranked)}
    if "" in counts:
        order[""] = len(ranked)  # no unit means no value to rank by, so it goes last
    return order


def by_value(order: dict):
    """Best value first: cheapest per unit within a unit group. A deal whose per-unit price is
    unknown sorts last rather than pretending to be free."""
    return lambda deal: (
        order.get(deal.unit, len(order)),
        deal.reference if deal.reference else float("inf"),
        deal.price,
    )


def flags_of(deal: Deal) -> str:
    """The conditions attached to a price: net of VAT, and needing the shop's loyalty card."""
    marks = []
    if deal.trade:
        marks.append(NET_MARK)
    if any(o.get("requiresLoyalityMembership") for o in deal.offers):
        marks.append(CARD_MARK)
    return "".join(f"  {mark}" for mark in marks)


def render_watch(label: str, offers: list, link_for, now: datetime, cap: int = CAP) -> str | None:
    """One watch's block, or None when it has no offers - a watch with nothing running is not
    worth a line, so it is left out entirely rather than reported as empty."""
    deals = group_offers(offers)
    order = unit_order(deals)
    running, upcoming = [], []
    for deal in sorted(deals, key=by_value(order)):
        per = f" ({money(deal.reference)}/{deal.unit})" if deal.reference and deal.unit else ""
        upcoming_deal = deal.starts > now
        when = f"from {day(deal.starts)}" if upcoming_deal else f"until {day(deal.ends)}"
        line = (f"  €{money(deal.price)}{per} · {', '.join(shops_of(deal.offers)) or '?'} "
                f"· {when}{flags_of(deal)}")
        link = link_for(deal.offers[0])
        if link:
            line += f"\n    {link}"
        (upcoming if upcoming_deal else running).append(line)

    if not running and not upcoming:
        return None
    lines = [f"*{label}*", *running[:cap]]
    if upcoming:
        lines += ["  _upcoming:_", *upcoming[:cap]]
    return "\n".join(lines)


def render_digest(blocks: list) -> str | None:
    """The whole digest, or None when no watch has anything - in which case nothing is sent.

    Undated on purpose: every line already carries the window its price runs in, so a date on the
    title would only repeat what is under it."""
    kept = [b for b in blocks if b]
    if not kept:
        return None
    return "🏷️ Offers\n\n" + "\n\n".join(kept)


def watch_line(watch: dict) -> str:
    parts = [f'query "{watch["query"]}"']
    if watch.get("brands"):
        parts.append(f"brands {','.join(map(str, watch['brands']))}")
    if watch.get("retailers"):
        parts.append(f"retailers {','.join(map(str, watch['retailers']))}")
    return f"- {watch['label']} ({'; '.join(parts)})"


# --- commands ------------------------------------------------------------


def cmd_config(args):
    config = load(CONFIG_FILE, {})
    code = config.get("zipCode")
    print(f"Postcode: {code}" if code else "Postcode: not set")
    watchlist = load(WATCH_FILE, {})
    print(f"Watches: {len(watchlist)}")


def cmd_config_set(args):
    if not args.zip.isdigit():
        die(f'invalid postcode "{args.zip}"')
    config = load(CONFIG_FILE, {})
    config["zipCode"] = args.zip
    save(CONFIG_FILE, config)
    print(f"postcode set to {args.zip}")


def cmd_brands(args):
    """Discovery: which brands a term matches, so a watch can be pinned to one exactly instead
    of relying on the provider's fuzzy text matching."""
    code = zip_code()
    facets = Provider().facets({"query": args.query}, code)
    brands = facets.get("brands") or []
    if not brands:
        print(f'no brands match "{args.query}" at {code}')
        return
    print(f'brands matching "{args.query}" at {code}:')
    for brand in brands:
        print(f"  {brand['id']}\t{brand['name']}\t({brand['resultsCount']} offer(s))")
    hint("[offers] pin the watch to the right id: watch-add --label ... --brands <id>")


def cmd_retailers(args):
    code = zip_code()
    facets = Provider().facets({"query": args.query}, code)
    retailers = facets.get("retailers") or []
    if not retailers:
        print(f'no retailers match "{args.query}" at {code}')
        return
    print(f'retailers carrying "{args.query}" at {code}:')
    for retailer in retailers:
        print(f"  {retailer['id']}\t{retailer['name']}\t({retailer['resultsCount']} offer(s))")


def verify_pins(provider: Provider, watch: dict):
    """Reject a pin that names nothing. Silence is this skill's way of saying "no offers", so an
    id that matches no brand must fail here - left in place it would look identical, forever."""
    for kind, noun in (("brands", "brand"), ("retailers", "retailer")):
        for ident in watch.get(kind) or []:
            if provider.name_of(kind, ident) is None:
                die(f"no {noun} has id {ident} - look it up with {kind} --query \"{watch['query']}\"")


def report_watch(provider: Provider, watch: dict, code: str, lead: str):
    """Announce a change to a watch together with where it stands. Setting a watch up and asking
    what it has are the same question asked once, and answering both proves the watch works."""
    offers, facets = provider.survey(watch, code)
    print(lead)
    block = render_watch(watch["label"], offers, lambda o: provider.leaflet_url(o, code),
                         datetime.now(TZ))
    print(block if block else "Nothing on offer right now - you'll hear when there is.")
    if not watch.get("brands"):
        brands = facets.get("brands") or []
        if len(brands) >= BROAD_BRANDS:
            names = ", ".join(f"{b['name']} ({b['id']})" for b in brands[:4])
            hint(f"[offers] \"{watch['query']}\" matches {len(brands)} brands, so this watch is "
                 f"broad and will report unrelated products. Pin it if the user meant one: {names}")


def cmd_watch_add(args):
    watchlist = load(WATCH_FILE, {})
    key = args.label.lower()
    if key in watchlist:
        die(f'already watching "{watchlist[key]["label"]}" - change it with watch-edit')
    code = zip_code()
    provider = Provider()
    watch = {
        "label": args.label,
        "query": args.query or args.label,
        "brands": args.brands,
        "retailers": args.retailers,
    }
    verify_pins(provider, watch)
    watchlist[key] = watch
    save(WATCH_FILE, watchlist)
    report_watch(provider, watch, code, f"👀 Now watching *{watch['label']}*.")


def cmd_watch_list(args):
    watchlist = load(WATCH_FILE, {})
    if not watchlist:
        print("No watches yet.")
        return
    print(f"{len(watchlist)} watch(es):")
    for watch in watchlist.values():
        print(watch_line(watch))


def cmd_watch_edit(args):
    watchlist = load(WATCH_FILE, {})
    key, watch, _ = find_watch(watchlist, args.label)
    changed = False
    if args.query is not None:
        watch["query"] = args.query
        changed = True
    if args.brands is not None:
        watch["brands"] = args.brands
        changed = True
    if args.retailers is not None:
        watch["retailers"] = args.retailers
        changed = True
    if args.rename:
        watch["label"] = args.rename
        changed = True
    if not changed:
        die("give at least one field to change (--query/--brands/--retailers/--rename)")
    new_key = watch["label"].lower()
    if new_key != key and new_key in watchlist:
        die(f'a different watch is already called "{watch["label"]}"')
    code = zip_code()
    provider = Provider()
    verify_pins(provider, watch)
    del watchlist[key]
    watchlist[new_key] = watch
    save(WATCH_FILE, watchlist)
    report_watch(provider, watch, code, f"✏️ Updated *{watch['label']}*.")


def cmd_watch_rm(args):
    watchlist = load(WATCH_FILE, {})
    key, watch, _ = find_watch(watchlist, args.label)
    del watchlist[key]
    save(WATCH_FILE, watchlist)
    print(f"🚫 Stopped watching *{watch['label']}*.")


def cmd_search(args):
    """One product, right now - the on-demand answer to "is X on offer?"."""
    code = zip_code()
    if args.watch:
        _, watch, assumed = find_watch(load(WATCH_FILE, {}), args.watch)
        if assumed:
            hint(f'[offers] read "{args.watch}" as {assumed}')
    else:
        watch = {"label": args.query, "query": args.query,
                 "brands": args.brands, "retailers": args.retailers}
    provider = Provider()
    offers = provider.search(watch, code)
    block = render_watch(watch["label"], offers, lambda o: provider.leaflet_url(o, code),
                         datetime.now(TZ), cap=args.limit)
    print(block if block else f"No offers on {watch['label']} at {code} right now.")


def cmd_digest(args):
    """The scheduled report: every watch, every day, whatever is running or coming up. No record
    of what was sent before is kept, so this always describes the present rather than a diff.

    Nothing set up yet is not a failure, so it prints nothing and says why to the caller alone:
    this runs unattended inside the daily briefing, where an error would become a daily false
    alarm, while the agent still gets told to ask for a postcode."""
    config = load(CONFIG_FILE, {})
    if not config.get("zipCode"):
        hint("[offers] no postcode set yet - ask the user for theirs once, then: "
             "offers.py config-set --zip 4020")
        return
    code = zip_code()
    watchlist = load(WATCH_FILE, {})
    if not watchlist:
        hint("[offers] nothing is being watched yet - nothing to report.")
        return
    provider = Provider()
    now = datetime.now(TZ)
    blocks = [
        render_watch(watch["label"], provider.search(watch, code),
                     lambda o: provider.leaflet_url(o, code), now)
        for watch in watchlist.values()
    ]
    digest = render_digest(blocks)
    if digest:
        print(digest)
    else:
        hint(f"[offers] nothing on offer for any of the {len(watchlist)} watch(es) - nothing sent.")


# --- delivery ------------------------------------------------------------


def deliver_to_user(text: str) -> str | None:
    """POST the reply to the app's localhost hook, which delivers it to the user on WhatsApp and
    returns the marker to print. Returns the response body (the marker); None only if the app
    could not be reached at all - the one case the caller falls back for."""
    port = os.environ.get("PORT", "8080")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/internal/skill-message?source=offers",
        data=text.encode("utf-8"),
        method="POST",
        headers={"Content-Type": "text/plain; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            return response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.read().decode("utf-8")
    except Exception:
        return None


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="offers.py", description="watch products for offers")
    sub = p.add_subparsers(dest="cmd", required=True)

    # `delivers` marks the commands whose output is written for the user - anything that describes
    # their watches or the offers on them, as against the ids behind it. Two of them also take
    # --quiet: an offer in a shop is the world's, not the user's, so the agent may read one to answer
    # in its own words - and the briefing composes the digest into a single morning message. A watch
    # is theirs, so nothing can read or change one out of their sight.
    def command(name: str, *, delivers: bool = False,
                silenceable: bool = False) -> argparse.ArgumentParser:
        parser = sub.add_parser(name)
        parser.set_defaults(delivers=delivers, quiet=False)
        if silenceable:
            parser.add_argument("--quiet", action="store_true",
                                help="print the result here instead of sending it to the user")
        return parser

    command("config").set_defaults(func=cmd_config)

    cs = command("config-set", delivers=True)
    cs.set_defaults(func=cmd_config_set)
    cs.add_argument("--zip", required=True)

    br = command("brands")
    br.set_defaults(func=cmd_brands)
    br.add_argument("--query", required=True)

    rt = command("retailers")
    rt.set_defaults(func=cmd_retailers)
    rt.add_argument("--query", required=True)

    wa = command("watch-add", delivers=True)
    wa.set_defaults(func=cmd_watch_add)
    wa.add_argument("--label", required=True)
    wa.add_argument("--query")
    wa.add_argument("--brands", type=id_list, default=[])
    wa.add_argument("--retailers", type=id_list, default=[])

    command("watch-list", delivers=True).set_defaults(func=cmd_watch_list)

    we = command("watch-edit", delivers=True)
    we.set_defaults(func=cmd_watch_edit)
    we.add_argument("--label", required=True)
    we.add_argument("--query")
    we.add_argument("--brands", type=id_list)
    we.add_argument("--retailers", type=id_list)
    we.add_argument("--rename")

    wr = command("watch-rm", delivers=True)
    wr.set_defaults(func=cmd_watch_rm)
    wr.add_argument("--label", required=True)

    se = command("search", delivers=True, silenceable=True)
    se.set_defaults(func=cmd_search)
    group = se.add_mutually_exclusive_group(required=True)
    group.add_argument("--query")
    group.add_argument("--watch")
    se.add_argument("--brands", type=id_list, default=[])
    se.add_argument("--retailers", type=id_list, default=[])
    se.add_argument("--limit", type=int, default=CAP)

    command("digest", delivers=True, silenceable=True).set_defaults(func=cmd_digest)

    return p


def main():
    args = build_parser().parse_args()
    if not WORKSPACE.is_dir():
        die(f"no workspace at {WORKSPACE} - this is not where the user's data is")
    # Capture the command's output so it can be delivered to the user directly, while still writing
    # it to stdout so the caller sees it (for its reasoning and to detect delivery success/failure).
    buffer = io.StringIO()
    try:
        with redirect_stdout(buffer):
            args.func(args)
    finally:
        sys.stdout.write(buffer.getvalue())
    output = buffer.getvalue()
    failed = False
    if output.strip() and args.delivers:
        if args.quiet:
            # Say so explicitly: without a marker the caller cannot tell a silent run from a sent one.
            sys.stdout.write("\n[offers: quiet - not sent to the user]\n")
        else:
            marker = deliver_to_user(output)
            failed = marker is None
            sys.stdout.write(
                marker
                if marker is not None
                else "\n[offers: delivery FAILED - relay the output above to the user yourself]\n"
            )
    for note in NOTES:
        sys.stdout.write(f"{note}\n")
    # The digest runs unattended, so a send that never happened has to fail loudly: there is no
    # agent reading the marker and no second chance. When the agent is the caller it relays the
    # output instead, and the marker above tells it to.
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
