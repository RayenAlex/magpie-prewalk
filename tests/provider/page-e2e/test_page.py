"""Behaviour test for the Prewalk settings page.

The page runs inside a `sandbox="allow-scripts"` iframe, exactly as magpie
serves plugin pages. The fixture provides the bridge contract the real
window provides, so the production `index.html`, `model.js` and `app.js` run
unmodified.

Run with:
    python3 -I tests/provider/page-e2e/test_page.py
"""

import base64
import json
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright

CHROME = os.environ.get("PREWALK_CHROMIUM") or None

ROOT = pathlib.Path(__file__).resolve().parents[3]
PAGE = ROOT / "src" / "provider" / "page"
FIXTURE = pathlib.Path(__file__).resolve().parent / "fixture.html"


def fail(message):
    print(f"FAIL {message}")
    return 1


def serve(route):
    path = route.request.url.split("?")[0]
    if path.endswith("/gallery.html"):
        body, ctype = FIXTURE.read_bytes(), "text/html; charset=utf-8"
    elif path.endswith("/_magpie/bridge.js"):
        body, ctype = (pathlib.Path(__file__).resolve().parent / "bridge.js").read_bytes(), "text/javascript; charset=utf-8"
    elif path.endswith("/app.js"):
        body, ctype = (PAGE / "app.js").read_bytes(), "text/javascript; charset=utf-8"
    elif path.endswith("/model.js"):
        body, ctype = (PAGE / "model.js").read_bytes(), "text/javascript; charset=utf-8"
    elif path.endswith("/index.html"):
        body, ctype = (PAGE / "index.html").read_bytes(), "text/html; charset=utf-8"
    elif path.endswith("/style.css"):
        body, ctype = (PAGE / "style.css").read_bytes(), "text/css; charset=utf-8"
    else:
        route.fulfill(status=404, body="missing")
        return
    route.fulfill(status=200, body=body, content_type=ctype)


def frame_doc(page):
    return page.frame_locator("#target")


def real_click(page, doc, selector):
    """Click like a person: real mouse coordinates on the page.

    Playwright's element click goes through the frame's own input bridge, which
    a sandboxed frame may not forward. Real pointer coordinates always work.
    """
    frame = page.query_selector("#target")
    fb = frame.bounding_box()
    bb = doc.locator(selector).bounding_box()
    page.mouse.click(
        fb["x"] + bb["x"] + bb["width"] / 2,
        fb["y"] + bb["y"] + bb["height"] / 2,
    )


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME)
        page = browser.new_page(viewport={"width": 1100, "height": 1400})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.route("**/*", serve)
        page.goto("http://prewalk.test/gallery.html")
        page.wait_for_timeout(800)

        doc = frame_doc(page)
        doc.locator("#form").wait_for(state="visible", timeout=5000)

        if doc.locator("#save").get_attribute("type") != "button":
            return fail("save button must not be a submit button in a sandbox")

        if doc.locator("#status").text_content() != "":
            return fail(f"status not empty on load: {doc.locator('#status').text_content()}")
        if doc.locator("#planner").input_value() != "a/planner":
            return fail(f"planner = {doc.locator('#planner').input_value()}")

        # Save the untouched form: this must reach the bridge.
        real_click(page, doc, "#save")
        page.wait_for_timeout(500)
        stored = page.evaluate("window.__stored")
        calls = page.evaluate("window.__calls")
        sets = [c for c in calls if c["method"] == "options.set"]
        if len(sets) != 1:
            return fail(f"options.set calls after save = {len(sets)}; calls={calls}")
        if stored["planner"] != "a/planner":
            return fail(f"stored planner = {stored['planner']}")

        # A slow-planner deadline above the former 30-second cap must save.
        doc.locator("#classifyTimeoutMs").fill("120000")
        doc.locator("#healthTimeoutMs").fill("1000")
        page.wait_for_timeout(1600)  # past the save cooldown
        real_click(page, doc, "#save")
        page.wait_for_timeout(500)
        stored = page.evaluate("window.__stored")
        if stored["classifyTimeoutMs"] != 120000:
            return fail(f"timeout not saved: {stored['classifyTimeoutMs']}")
        if stored["healthTimeoutMs"] != 1000:
            return fail(f"health timeout not saved independently: {stored['healthTimeoutMs']}")
        status = doc.locator("#status").text_content()
        if "已保存" not in status:
            return fail(f"status after save = {status!r}")

        # A click inside the cooldown must not post another save.
        sets_before = len([c for c in page.evaluate("window.__calls") if c["method"] == "options.set"])
        real_click(page, doc, "#save")
        page.wait_for_timeout(200)
        sets_after = len([c for c in page.evaluate("window.__calls") if c["method"] == "options.set"])
        if sets_after != sets_before:
            return fail(f"cooldown did not block a save: {sets_before} -> {sets_after}")
        if "请等" not in doc.locator("#status").text_content():
            return fail(f"cooldown gave no message: {doc.locator('#status').text_content()!r}")

        # An invalid value must not be written.
        before = json.dumps(stored, sort_keys=True)
        doc.locator("#classifyTimeoutMs").fill("5")
        page.wait_for_timeout(1600)
        real_click(page, doc, "#save")
        page.wait_for_timeout(300)
        after = json.dumps(page.evaluate("window.__stored"), sort_keys=True)
        if before != after:
            return fail("invalid timeout was written")
        if "1000" not in doc.locator("[data-error='classifyTimeoutMs']").text_content():
            return fail("no validation message for invalid timeout")

        if errors:
            return fail(f"page errors: {errors}")

        # The page must have reloaded the stored options after saving.
        if not any(c["method"] == "options.get" for c in page.evaluate("window.__calls")):
            return fail("page never read options")

        browser.close()
    print("PASS prewalk page save")
    return 0


if __name__ == "__main__":
    sys.exit(main())
