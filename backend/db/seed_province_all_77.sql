-- AgroLink -- registry.province: เติมให้ครบ 77 จังหวัด
--
-- grant_cooperative_tenant_foundation.sql seed ไว้เพียง 16 จังหวัด (เฉพาะที่อยู่ใน
-- National_Selection_Database_50_Cooperatives) ทำให้ dropdown "จังหวัด" ในฟอร์ม
-- จัดตั้งสหกรณ์ของแอดมินมีไม่ครบ ไฟล์นี้เพิ่มจังหวัดที่เหลือ (รวมกรุงเทพมหานคร)
-- ตามการแบ่ง 6 ภาคของคณะกรรมการภูมิศาสตร์แห่งชาติ
--
-- - ใช้ ON CONFLICT DO NOTHING: 16 แถวเดิม (รหัส/ภาค) ไม่ถูกแก้ ข้อมูลสหกรณ์ที่
--   อ้างอิงรหัสเดิมจึงไม่กระทบ
-- - รันซ้ำได้ ต้องรันหลัง grant_cooperative_tenant_foundation.sql

INSERT INTO registry.province (province_code, province_name_th, region_th) VALUES
  -- เหนือ
  ('CHIANG_MAI',               'เชียงใหม่',          'เหนือ'),
  ('CHIANG_RAI',               'เชียงราย',          'เหนือ'),
  ('LAMPANG',                  'ลำปาง',             'เหนือ'),
  ('LAMPHUN',                  'ลำพูน',             'เหนือ'),
  ('MAE_HONG_SON',             'แม่ฮ่องสอน',        'เหนือ'),
  ('NAN',                      'น่าน',              'เหนือ'),
  ('PHAYAO',                   'พะเยา',             'เหนือ'),
  ('PHRAE',                    'แพร่',              'เหนือ'),
  ('UTTARADIT',                'อุตรดิตถ์',          'เหนือ'),
  -- อีสาน
  ('AMNAT_CHAROEN',            'อำนาจเจริญ',        'อีสาน'),
  ('BUENG_KAN',                'บึงกาฬ',            'อีสาน'),
  ('BURI_RAM',                 'บุรีรัมย์',          'อีสาน'),
  ('CHAIYAPHUM',               'ชัยภูมิ',            'อีสาน'),
  ('KALASIN',                  'กาฬสินธุ์',          'อีสาน'),
  ('KHON_KAEN',                'ขอนแก่น',           'อีสาน'),
  ('LOEI',                     'เลย',               'อีสาน'),
  ('MAHA_SARAKHAM',            'มหาสารคาม',         'อีสาน'),
  ('MUKDAHAN',                 'มุกดาหาร',          'อีสาน'),
  ('NAKHON_PHANOM',            'นครพนม',            'อีสาน'),
  ('NAKHON_RATCHASIMA',        'นครราชสีมา',        'อีสาน'),
  ('NONG_BUA_LAM_PHU',         'หนองบัวลำภู',       'อีสาน'),
  ('NONG_KHAI',                'หนองคาย',           'อีสาน'),
  ('ROI_ET',                   'ร้อยเอ็ด',           'อีสาน'),
  ('SAKON_NAKHON',             'สกลนคร',            'อีสาน'),
  ('SI_SA_KET',                'ศรีสะเกษ',          'อีสาน'),
  ('SURIN',                    'สุรินทร์',           'อีสาน'),
  ('UBON_RATCHATHANI',         'อุบลราชธานี',       'อีสาน'),
  ('UDON_THANI',               'อุดรธานี',          'อีสาน'),
  ('YASOTHON',                 'ยโสธร',             'อีสาน'),
  -- กลาง
  ('BANGKOK',                  'กรุงเทพมหานคร',     'กลาง'),
  ('ANG_THONG',                'อ่างทอง',           'กลาง'),
  ('CHAI_NAT',                 'ชัยนาท',            'กลาง'),
  ('PHRA_NAKHON_SI_AYUTTHAYA', 'พระนครศรีอยุธยา',   'กลาง'),
  ('KAMPHAENG_PHET',           'กำแพงเพชร',         'กลาง'),
  ('LOP_BURI',                 'ลพบุรี',             'กลาง'),
  ('NAKHON_NAYOK',             'นครนายก',           'กลาง'),
  ('NAKHON_PATHOM',            'นครปฐม',            'กลาง'),
  ('NAKHON_SAWAN',             'นครสวรรค์',         'กลาง'),
  ('NONTHABURI',               'นนทบุรี',            'กลาง'),
  ('PATHUM_THANI',             'ปทุมธานี',           'กลาง'),
  ('PHETCHABUN',               'เพชรบูรณ์',          'กลาง'),
  ('PHICHIT',                  'พิจิตร',             'กลาง'),
  ('PHITSANULOK',              'พิษณุโลก',           'กลาง'),
  ('SAMUT_PRAKAN',             'สมุทรปราการ',       'กลาง'),
  ('SAMUT_SAKHON',             'สมุทรสาคร',         'กลาง'),
  ('SAMUT_SONGKHRAM',          'สมุทรสงคราม',       'กลาง'),
  ('SARABURI',                 'สระบุรี',            'กลาง'),
  ('SING_BURI',                'สิงห์บุรี',           'กลาง'),
  ('SUKHOTHAI',                'สุโขทัย',            'กลาง'),
  ('SUPHAN_BURI',              'สุพรรณบุรี',         'กลาง'),
  ('UTHAI_THANI',              'อุทัยธานี',          'กลาง'),
  -- ตะวันออก
  ('CHACHOENGSAO',             'ฉะเชิงเทรา',        'ตะวันออก'),
  ('CHANTHABURI',              'จันทบุรี',           'ตะวันออก'),
  ('CHON_BURI',                'ชลบุรี',             'ตะวันออก'),
  ('PRACHIN_BURI',             'ปราจีนบุรี',         'ตะวันออก'),
  ('RAYONG',                   'ระยอง',             'ตะวันออก'),
  ('SA_KAEO',                  'สระแก้ว',            'ตะวันออก'),
  ('TRAT',                     'ตราด',              'ตะวันออก'),
  -- ตะวันตก
  ('KANCHANABURI',             'กาญจนบุรี',         'ตะวันตก'),
  ('PHETCHABURI',              'เพชรบุรี',           'ตะวันตก'),
  ('PRACHUAP_KHIRI_KHAN',      'ประจวบคีรีขันธ์',    'ตะวันตก'),
  ('RATCHABURI',               'ราชบุรี',            'ตะวันตก'),
  ('TAK',                      'ตาก',               'ตะวันตก'),
  -- ใต้
  ('CHUMPHON',                 'ชุมพร',             'ใต้'),
  ('KRABI',                    'กระบี่',             'ใต้'),
  ('NAKHON_SI_THAMMARAT',      'นครศรีธรรมราช',     'ใต้'),
  ('NARATHIWAT',               'นราธิวาส',          'ใต้'),
  ('PATTANI',                  'ปัตตานี',            'ใต้'),
  ('PHANGNGA',                 'พังงา',             'ใต้'),
  ('PHATTHALUNG',              'พัทลุง',             'ใต้'),
  ('PHUKET',                   'ภูเก็ต',             'ใต้'),
  ('RANONG',                   'ระนอง',             'ใต้'),
  ('SATUN',                    'สตูล',              'ใต้'),
  ('SONGKHLA',                 'สงขลา',             'ใต้'),
  ('SURAT_THANI',              'สุราษฎร์ธานี',       'ใต้'),
  ('TRANG',                    'ตรัง',              'ใต้'),
  ('YALA',                     'ยะลา',              'ใต้')
ON CONFLICT (province_code) DO NOTHING;

COMMENT ON TABLE registry.province IS
  'อ้างอิงจังหวัด ครบ 77 จังหวัด (seed_province_all_77.sql) แบ่ง 6 ภาคตามคณะกรรมการภูมิศาสตร์แห่งชาติ — 16 แถวแรกจาก grant_cooperative_tenant_foundation.sql คงภาคเดิมไว้ (พิษณุโลก/สุโขทัย = เหนือ)';

-- ตรวจผล: ควรได้ 77
SELECT count(*) AS province_count FROM registry.province;
