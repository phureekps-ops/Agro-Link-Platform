# -*- coding: utf-8 -*-
import io, sys

def patch(path, replacements):
    with io.open(path, encoding="utf-8") as f:
        content = f.read()
    for old, new in replacements:
        count = content.count(old)
        if count != 1:
            print("FAIL %s: expected 1 match, got %d for snippet starting: %r" % (path, count, old[:80]))
            sys.exit(1)
        content = content.replace(old, new, 1)
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("OK " + path)

# 1. backend/src/routes/organization.js
patch("backend/src/routes/organization.js", [
(
"""const ORG_REQUESTABLE_ROLE_TYPES = [
  'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
  'MachineryService', 'DryingYardService',
  'FertilizerMixingService',
];""",
"""// 'BiomassProducer' added 2026-10-24 for the "พอร์ทัลผู้ผลิตสินค้าจากชีวมวล"
// (Biomass Product Producer Portal) feature — per the user's own explicit
// scoping, members are already-registered organizations (Cooperative/
// farmer-group etc.), not a from-scratch org_type, so this is
// REQUESTABLE-only, same additive pattern as every type above. See
// grant_biomass_producer_portal.sql for why this is deliberately NOT also
// added to auth.js's ORG_SELF_REGISTER_TYPES / organization_org_type_check
// (only to organization_role_role_type_check).
const ORG_REQUESTABLE_ROLE_TYPES = [
  'InputSupplier', 'Lender', 'Logistics', 'Buyer', 'VillageFund',
  'MachineryService', 'DryingYardService',
  'FertilizerMixingService',
  'BiomassProducer',
];"""
),
(
"""  DryingYardService: 'บริการลานตากข้าว/โกดังและไซโล',
  FertilizerMixingService: 'ผู้ให้บริการผสมปุ๋ยสั่งตัด',
};""",
"""  DryingYardService: 'บริการลานตากข้าว/โกดังและไซโล',
  FertilizerMixingService: 'ผู้ให้บริการผสมปุ๋ยสั่งตัด',
  BiomassProducer: 'ผู้ผลิตสินค้าจากชีวมวล',
};"""
),
])

# 2. backend/src/server.js
patch("backend/src/server.js", [
(
"const inputSupplierRouter = require('./routes/inputsupplier');",
"const inputSupplierRouter = require('./routes/inputsupplier');\nconst biomassRouter = require('./routes/biomass');"
),
(
"app.use('/inputsupplier', inputSupplierRouter);",
"app.use('/inputsupplier', inputSupplierRouter);\napp.use('/biomass', biomassRouter);"
),
])

# 3. frontend/admin/js/dashboard.js
patch("frontend/admin/js/dashboard.js", [
(
"""  MarketVenue: "ตลาดค้าส่ง/ผู้ให้บริการพื้นที่ขายสินค้าเกษตร", FertilizerMixingService: "ผู้ให้บริการผสมปุ๋ยสั่งตัด",""",
"""  MarketVenue: "ตลาดค้าส่ง/ผู้ให้บริการพื้นที่ขายสินค้าเกษตร", FertilizerMixingService: "ผู้ให้บริการผสมปุ๋ยสั่งตัด",
  BiomassProducer: "ผู้ผลิตสินค้าจากชีวมวล","""
),
])

print("ALL DONE")
