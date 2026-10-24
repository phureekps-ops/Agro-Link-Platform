# -*- coding: utf-8 -*-
import io, sys

path = "frontend/biomass-portal.html"
with io.open(path, encoding="utf-8") as f:
    content = f.read()

OLD = '''    <div class="hero-cta">
      <a href="contact.html" class="btn btn-gold"><i class="fa-solid fa-handshake"></i><span data-i18n="biomass-portal_4"> ติดต่อทีมงานเพื่อเป็นพันธมิตร</span></a>
      <a href="integrated-rice-business.html" class="btn btn-outline" style="border-color:rgba(255,255,255,.35); color:#fff;"><i class="fa-solid fa-wheat-awn"></i><span data-i18n="biomass-portal_5"> ดูโครงการธุรกิจข้าวครบวงจร</span></a>
    </div>'''
NEW = '''    <div class="hero-cta">
      <a href="contact.html" class="btn btn-gold"><i class="fa-solid fa-handshake"></i><span data-i18n="biomass-portal_4"> ติดต่อทีมงานเพื่อเป็นพันธมิตร</span></a>
      <a href="integrated-rice-business.html" class="btn btn-outline" style="border-color:rgba(255,255,255,.35); color:#fff;"><i class="fa-solid fa-wheat-awn"></i><span data-i18n="biomass-portal_5"> ดูโครงการธุรกิจข้าวครบวงจร</span></a>
      <a href="biomassproducer-directory.html" class="btn btn-outline" style="border-color:rgba(255,255,255,.35); color:#fff;"><i class="fa-solid fa-recycle"></i> ดูทำเนียบผู้ผลิตสินค้าจากชีวมวล</a>
    </div>'''

count = content.count(OLD)
if count != 1:
    print("FAIL: count=%d" % count)
    sys.exit(1)
content = content.replace(OLD, NEW, 1)
with io.open(path, "w", encoding="utf-8") as f:
    f.write(content)
print("OK " + path)
