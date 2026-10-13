/**
 * Shared TH/EN dictionary for the header nav and footer markup that is
 * repeated, word-for-word, across AgroLink's public/marketing pages.
 * Loaded on every public page alongside that page's own i18n-<page>.js
 * and the shared js/i18n.js engine. Keys match the ones used in
 * frontend/js/i18n-index.js (the homepage) so the two stay interchangeable.
 */
window.AGROLINK_I18N = Object.assign(window.AGROLINK_I18N || {}, {
  // ---------- Header / nav ----------
  logo_alt: { th: "AgroLink", en: "AgroLink" },
  nav_home: { th: "หน้าแรก", en: "Home" },
  nav_coop: { th: "สำหรับสหกรณ์", en: "For Cooperatives" },
  nav_coop_fert: { th: "ปุ๋ยสั่งตัด", en: "Custom Fertilizer" },
  nav_coop_rice: { th: "ธุรกิจข้าวครบวงจร", en: "Integrated Rice Business" },
  nav_coop_carbon: { th: "คาร์บอนเครดิต", en: "Carbon Credit" },
  nav_coop_biomass: { th: "เศรษฐกิจชีวมวล", en: "Biomass Economy" },
  nav_coop_durian: { th: "ทุเรียนครบวงจร", en: "Integrated Durian Business" },
  nav_coop_cassava: { th: "มันสำปะหลังครบวงจร", en: "Integrated Cassava Business" },
  nav_farmers: { th: "สำหรับเกษตรกร", en: "For Farmers" },
  nav_finance: { th: "การเงิน", en: "Finance" },
  nav_marketplace: { th: "ตลาดกลาง", en: "Marketplace" },
  nav_ai: { th: "AI และดาวเทียม", en: "AI & Satellite" },
  nav_investor: { th: "นักลงทุน", en: "Investors" },
  nav_login: { th: "เข้าสู่ระบบ", en: "Log In" },
  nav_demo: { th: "ขอชม Demo", en: "Request a Demo" },
  nav_back_home: { th: "← กลับหน้าแรก", en: "← Back to Home" },
  nav_farmer_login: { th: "เข้าสู่ระบบเกษตรกร", en: "Farmer Log In" },

  // ---------- Footer ----------
  footer_tagline: { th: "โครงสร้างพื้นฐานดิจิทัลสำหรับภาคเกษตร", en: "Digital infrastructure for agriculture" },
  footer_desc: {
    th: "เชื่อมเกษตรกร สหกรณ์ บริการ การเงิน และตลาด ด้วยข้อมูลจากการผลิตจริง",
    en: "Connecting farmers, cooperatives, services, finance, and markets through real production data.",
  },
  footer_h_products: { th: "ผลิตภัณฑ์", en: "Products" },
  footer_product_1: { th: "สหกรณ์/กลุ่มเกษตรกร", en: "Cooperatives / Farmer Groups" },
  footer_product_2: { th: "เกษตรกร", en: "Farmers" },
  footer_product_3: { th: "การเงิน", en: "Finance" },
  footer_product_4: { th: "ตลาดกลาง", en: "Marketplace" },
  footer_product_5: { th: "ปุ๋ยสั่งตัด", en: "Custom Fertilizer" },
  footer_product_6: { th: "ธุรกิจข้าวครบวงจร", en: "Integrated Rice Business" },
  footer_product_7: { th: "AI และดาวเทียม", en: "AI & Satellite" },
  footer_product_8: { th: "คาร์บอนเครดิต", en: "Carbon Credit" },
  footer_product_9: { th: "เศรษฐกิจชีวมวล", en: "Biomass Economy" },
  footer_product_10: { th: "แผนขยายสินค้า", en: "Expansion Roadmap" },
  footer_product_11: { th: "ทุเรียนครบวงจร", en: "Integrated Durian Business" },
  footer_product_12: { th: "มันสำปะหลังครบวงจร", en: "Integrated Cassava Business" },
  footer_h_partners: { th: "พันธมิตร", en: "Partners" },
  footer_partner_1: { th: "สหกรณ์/กลุ่มเกษตรกร", en: "Cooperatives / Farmer Groups" },
  footer_partner_2: { th: "สถาบันการเงิน", en: "Financial Institutions" },
  footer_partner_3: { th: "ผู้ซื้อ", en: "Buyers" },
  footer_partner_4: { th: "ผู้ให้บริการ", en: "Service Providers" },
  footer_partner_5: { th: "พันธมิตรเทคโนโลยี", en: "Technology Partners" },
  footer_partner_6: { th: "ผู้รับซื้อชีวมวล", en: "Biomass Buyers" },
  footer_partner_7: { th: "ผู้ให้บริการขนส่ง", en: "Logistics Providers" },
  footer_h_company: { th: "บริษัท", en: "Company" },
  footer_company_1: { th: "เกี่ยวกับเรา", en: "About Us" },
  footer_company_2: { th: "นักลงทุน", en: "Investors" },
  footer_company_3: { th: "ติดต่อเรา", en: "Contact Us" },
  footer_company_4: { th: "นโยบายความเป็นส่วนตัว", en: "Privacy Policy" },
  footer_company_5: { th: "ข้อกำหนดการใช้งาน", en: "Terms of Use" },
  footer_bottom_tagline: {
    th: "AgroLink — เชื่อมเกษตรกร สหกรณ์ บริการ การเงิน และตลาด ด้วยข้อมูลจากการผลิตจริง",
    en: "AgroLink — connecting farmers, cooperatives, services, finance, and markets through real production data.",
  },
  footer_copyright: {
    th: "© 2026 Pakdee Corporation Co.,Ltd. — เว็บไซต์ต้นแบบสำหรับนำเสนอแนวคิดผลิตภัณฑ์ (Product Concept Preview)",
    en: "© 2026 Pakdee Corporation Co.,Ltd. — Product concept preview website",
  },
});
