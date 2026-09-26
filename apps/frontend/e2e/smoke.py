#!/usr/bin/env python3
"""
Browser smoke test for the frontend, run against the in-memory mock API.

  pip install playwright pillow && playwright install chromium
  python3 apps/frontend/e2e/smoke.py

Starts `dev/mock-server.mjs` and Vite itself. Exercises the flows that are easy
to break silently: upload + live processing updates over SSE, selection with
undo, viewer keyboard/history behaviour, password-protected public sharing,
and the admin route guard.
"""
import os, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

FE = Path(__file__).resolve().parent.parent
BASE = 'http://localhost:5173'
failures = []

def check(cond, msg):
    print(('  ok   ' if cond else '  FAIL ') + msg)
    if not cond: failures.append(msg)

tmp = Path(tempfile.mkdtemp())
from PIL import Image
Image.new('RGB', (640, 480), (40, 120, 200)).save(tmp / 'holiday.png')
(tmp / 'notes.txt').write_text('not media')

env = dict(os.environ, MOCK_VIDEO='webm')
mock = subprocess.Popen(['node', 'dev/mock-server.mjs'], cwd=FE, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
vite = subprocess.Popen(['npx', 'vite', '--port', '5173', '--strictPort'], cwd=FE, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(5)
page_errors = []

def login(page, email='demo@example.com'):
    page.goto(f'{BASE}/login')
    page.fill('input[type=email]', email); page.fill('input[type=password]', 'password123')
    page.click('button.btn-primary'); page.wait_for_url('**/library')
    page.wait_for_selector('.tile, .empty', timeout=8000)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
        page = ctx.new_page()
        page.on('pageerror', lambda e: page_errors.append(str(e)))
        page.on('console', lambda m: page_errors.append(m.text) if m.type == 'error' else None)
        login(page)

        print('\nAuth guard')
        anon = browser.new_context().new_page()
        anon.goto(f'{BASE}/favorites'); anon.wait_for_url('**/login')
        check(True, 'signed-out visit to a protected route redirects to /login')

        print('\nUpload + live processing')
        total_before = page.locator('.tile').count()
        page.set_input_files('input[type=file]', [str(tmp / 'holiday.png'), str(tmp / 'notes.txt')])
        page.wait_for_selector('.tray')
        page.wait_for_selector('.tray-item.error', timeout=5000)
        check('Only images and videos' in page.locator('.tray-item.error').inner_text(), 'non-media file is rejected client-side with a clear message')
        page.wait_for_selector('.tray-item.done', timeout=10000)
        check(page.locator('.tile').count() == total_before + 1, 'uploaded image appears in the library without a reload')
        strip = page.locator('.tile .pipeline').first
        check(strip.count() == 1 or page.locator('.tile .pipeline').count() >= 1, 'new tile shows the processing pipeline strip')
        # Mock workers finish one job every ~3s (4 jobs): SSE must flip it to ready with no reload.
        page.wait_for_function("() => !document.querySelector('.tile:first-child .pipeline') || document.querySelectorAll('.tile .pipeline').length === 0", timeout=30000)
        check(True, 'pipeline strip disappears when workers finish (pushed over SSE, no polling/reload)')

        print('\nSearch + favorites')
        page.fill('.search input', 'tram'); page.wait_for_url('**q=tram**')
        page.wait_for_function("() => document.querySelectorAll('.tile').length >= 1 && document.querySelectorAll('.tile').length <= 3")
        check(page.locator('.tile').count() >= 1, 'search filters the library (url-driven ?q=)')
        page.fill('.search input', ''); page.wait_for_function("() => !location.search.includes('q=')")
        page.goto(f'{BASE}/favorites'); page.wait_for_selector('.tile')
        fav_count = page.locator('.tile').count()
        page.locator('.tile').first.hover(); page.locator('.tile .tile-fav').first.click()
        page.wait_for_function(f"() => document.querySelectorAll('.tile').length === {fav_count - 1}")
        check(True, 'un-favoriting removes the tile from Favorites')

        print('\nSelection, trash and undo')
        page.goto(f'{BASE}/library'); page.wait_for_selector('.tile img.in')
        n = page.locator('.tile').count()
        page.locator('.tile .tile-check').nth(1).click(force=True)
        page.locator('.tile .tile-check').nth(4).click(force=True, modifiers=['Shift'])
        check(page.locator('.bulkbar strong').inner_text() == '4 selected', 'shift-click selects the whole range (4 items)')
        page.click('.bulkbar >> text=Trash'); page.click('.dialog >> text=Move to trash')
        page.wait_for_function(f"() => document.querySelectorAll('.tile').length === {n - 4}")
        check(page.locator('.toast:has-text("Moved 4 items to trash")').count() == 1, 'trash shows a toast')
        page.click('.toast-action:has-text("Undo")')
        page.wait_for_function(f"() => document.querySelectorAll('.tile').length === {n}")
        check(True, 'Undo restores all 4 items')

        print('\nViewer')
        page.goto(f'{BASE}/library'); page.wait_for_selector('.tile img.in')
        page.locator('.tile .tile-main').nth(2).click(); page.wait_for_selector('.viewer')
        t1 = page.locator('.viewer-title strong').inner_text()
        page.keyboard.press('ArrowRight'); page.wait_for_function("(t) => document.querySelector('.viewer-title strong').innerText !== t", arg=t1)
        check('asset=' in page.url, 'arrow key moves to the next item and the URL follows (deep-linkable)')
        page.keyboard.press('f'); page.wait_for_selector('.viewer-actions .fav-on')
        check(True, '"F" toggles favorite in the viewer')
        page.keyboard.press('Escape'); page.wait_for_selector('.viewer', state='detached')
        check('asset=' not in page.url, 'Escape closes the viewer and clears the URL')
        page.reload(); page.wait_for_selector('.tile')
        page.goto(f'{BASE}/library?asset=does-not-matter'); page.wait_for_selector('.viewer')
        check(True, 'unknown asset id in URL opens the viewer shell without crashing')
        page.goto(f'{BASE}/assets/abc'); page.wait_for_url('**/library?asset=abc')
        check(True, 'legacy /assets/:id links redirect to the new viewer URL')

        print('\nSharing with a password')
        page.goto(f'{BASE}/library'); page.wait_for_selector('.tile img.in')
        page.locator('.tile .tile-main').nth(2).click(); page.wait_for_selector('.viewer')
        page.click('button[aria-label="Share"]'); page.wait_for_selector('.dialog')
        page.fill('.dialog input[type=password]', 'hunter22'); page.click('.dialog button:has-text("Create link")')
        page.wait_for_selector('.share-fresh')
        link = page.input_value('.share-fresh input')
        check('/s/' in link, 'a share link is created and displayed')
        pub = browser.new_context().new_page(); pub.goto(link)
        pub.wait_for_selector('text=This link is protected')
        check(True, 'public visitor (no login) is asked for the password')
        pub.fill('input[type=password]', 'wrong'); pub.click('button:has-text("View")')
        pub.wait_for_selector('text=That password isn’t right')
        check(True, 'wrong password shows an inline error')
        pub.fill('input[type=password]', 'hunter22'); pub.click('button:has-text("View")')
        pub.wait_for_selector('.public-grid .tile')
        check(True, 'correct password reveals the shared media')
        pub.goto(f'{BASE}/s/not-a-real-token'); pub.wait_for_selector('text=Link not available')
        check(True, 'unknown token shows a friendly not-available page')

        print('\nAdmin guard')
        user = browser.new_context().new_page(); login(user, 'someone@example.com')
        check(user.locator('nav a:has-text("Operations")').count() == 0, 'non-admin does not see the Operations link')
        user.goto(f'{BASE}/admin'); user.wait_for_url('**/library')
        check(True, 'non-admin is redirected away from /admin')
        check(page.locator('nav a:has-text("Operations")').count() == 1, 'admin sees the Operations link')

        print('\nResponsive shell')
        m = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True).new_page(); login(m)
        check(m.locator('.bottom-nav').is_visible() and not m.locator('.sidebar').is_visible(), 'phone: bottom tab bar replaces the sidebar')
        t = browser.new_context(viewport={'width': 820, 'height': 1000}).new_page(); login(t)
        check(t.locator('.sidebar').is_visible() and t.locator('.sidebar .brand-name').is_hidden(), 'tablet: sidebar collapses to an icon rail')
        no_x = m.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth")
        check(no_x, 'phone: no horizontal scrolling')

        real = [e for e in page_errors if 'Failed to load resource' not in e]
        check(not real, f'no uncaught page errors / console errors ({real[:2]})')
        browser.close()
finally:
    mock.terminate(); vite.terminate()

print(f"\n{'FAILED: ' + str(len(failures)) if failures else 'All UI checks passed'}")
sys.exit(1 if failures else 0)
