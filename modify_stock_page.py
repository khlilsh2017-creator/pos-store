from pathlib import Path

path = Path(__file__).parent / 'stock-movements.html'
text = path.read_text(encoding='utf-8')
start = text.index('  <div class="container">')
end = text.index('  </main>', start)
new_main = '''  <div class="container">
  <div class="header">
    <div><h1><i class="fas fa-boxes"></i> حركات المنتجات</h1><p style="color:var(--muted);margin-top:4px;">ابحث عن منتج واحد لعرض سجل حركاته ورصيده النهائي.</p></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;"><a class="btn btn-outline" href="products.html"><i class="fas fa-boxes"></i> المنتجات</a><a class="btn btn-outline" href="index.html"><i class="fas fa-home"></i> الرئيسية</a><button class="btn btn-outline" id="printMovementBtn" onclick="printSelectedMovements()" disabled><i class="fas fa-print"></i> طباعة الحركة</button></div>
  </div>

  <div class="card no-print">
    <h3 style="margin-bottom:10px;"><i class="fas fa-search"></i> تحديد المنتج</h3>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <div class="lookup-wrap">
        <input type="search" id="productSearchInput" autocomplete="off" placeholder="اكتب اسم المنتج أو الباركود أو كود المنتج..." aria-label="بحث عن منتج" />
        <div id="productSuggestions" class="product-suggestions" hidden></div>
      </div>
      <button class="btn" onclick="searchProducts()"><i class="fas fa-search"></i> بحث</button>
      <button class="btn btn-outline" onclick="clearProductSelection()"><i class="fas fa-times"></i> مسح</button>
    </div>
    <div id="searchHint" class="text-muted" style="margin-top:9px;font-size:.85rem;">لن يتم عرض المنتجات أو الحركات حتى تحدد منتجًا.</div>
  </div>

  <div id="selectedProductCard" class="card selected-product-card" hidden>
    <div><div class="text-muted" style="font-size:.82rem;">المنتج المحدد</div><h2 id="selectedProductName" style="margin:3px 0 2px;"></h2><div id="selectedProductMeta" class="text-muted"></div></div>
    <div class="balance-highlight"><span class="text-muted">الرصيد النهائي الحالي</span><strong id="closingBalance">0</strong><small id="latestOperationLabel" class="text-muted">حسب آخر عملية</small></div>
  </div>

  <div id="movementCard" class="card" hidden>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;"><div><h3 style="margin:0;"><i class="fas fa-list"></i> جدول حركة المنتج</h3><p id="movementSummary" class="text-muted" style="margin-top:4px;"></p></div><div id="movementPager" class="pagination" style="margin:0;"></div></div>
    <div class="table-wrapper" style="margin-top:14px;">
      <table class="movement-table"><thead><tr><th>#</th><th>التاريخ</th><th>النوع / المرجع</th><th>الرصيد قبل العملية</th><th>التغيير</th><th>الرصيد بعد العملية</th><th>المورد</th><th>المستخدم</th><th>الملاحظة</th></tr></thead><tbody id="movementTableBody"><tr><td colspan="9" class="loading">حدد منتجًا لعرض الحركات</td></tr></tbody></table>
    </div>
  </div>

  <div id="movementEmpty" class="card empty-state"><i class="fas fa-hand-pointer"></i><strong>حدد منتجًا أولًا</strong><div style="margin-top:5px;">سيظهر هنا جدول حركات المنتج المحدد فقط، مرتبًا من آخر عملية إلى الأقدم.</div></div>
</div>
'''
path.write_text(text[:start] + new_main + text[end:], encoding='utf-8')
print('stock main replaced')
