# -*- coding: utf-8 -*-
import io, sys

PORTAL_FILES = [
    "frontend/admin/index.html",
    "frontend/buyer/index.html",
    "frontend/communityenterprise/index.html",
    "frontend/coop/index.html",
    "frontend/dryingyard/index.html",
    "frontend/farmeraidfund/index.html",
    "frontend/inputsupplier/index.html",
    "frontend/lender/index.html",
    "frontend/machinery/index.html",
    "frontend/marketvenue/index.html",
]

OLD = '<a href="../fertilizermixing/index.html" class="btn btn-ghost" style="width:100%; text-align:center; display:block; box-sizing:border-box; margin-bottom:8px;">ไปที่พอร์ทัลผู้ให้บริการผสมปุ๋ยสั่งตัด</a>'
NEW = OLD + '\n    <a href="../biomassproducer/index.html" class="btn btn-ghost" style="width:100%; text-align:center; display:block; box-sizing:border-box; margin-bottom:8px;">ไปที่พอร์ทัลผู้ผลิตสินค้าจากชีวมวล</a>'

ok = 0
for path in PORTAL_FILES:
    with io.open(path, encoding="utf-8") as f:
        content = f.read()
    count = content.count(OLD)
    if count != 1:
        print("SKIP (anchor not found exactly once, count=%d): %s" % (count, path))
        continue
    content = content.replace(OLD, NEW, 1)
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("OK " + path)
    ok += 1

print("Patched %d/%d portal files" % (ok, len(PORTAL_FILES)))

# login.html — add a portal-card after the insurance card, before gov
with io.open("frontend/login.html", encoding="utf-8") as f:
    login_content = f.read()

OLD_LOGIN = '''<a href="insurance/index.html" class="portal-card">
        <span class="icon">\U0001F6E1️</span>
        <span><span class="label">ผู้ให้บริการประกันภัย</span><span class="desc">ภาพรวมกรมธรรม์ ความเสี่ยงจากดาวเทียม/AI และคำร้องขอสินไหมทดแทน (ตัวอย่างพอร์ทัล)</span></span>
      </a>'''
NEW_LOGIN = OLD_LOGIN + '''
      <a href="biomassproducer/index.html" class="portal-card">
        <span class="icon">♻️</span>
        <span><span class="label">ผู้ผลิตสินค้าจากชีวมวล</span><span class="desc">ฟางอัดก้อน/อัดเม็ด ยอดอ้อยอัดก้อน ไบโอชาร์ และปุ๋ยอินทรีย์</span></span>
      </a>'''

count = login_content.count(OLD_LOGIN)
if count == 1:
    login_content = login_content.replace(OLD_LOGIN, NEW_LOGIN, 1)
    with io.open("frontend/login.html", "w", encoding="utf-8") as f:
        f.write(login_content)
    print("OK frontend/login.html")
else:
    print("SKIP login.html (anchor count=%d)" % count)

print("DONE")
