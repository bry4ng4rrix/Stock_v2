import os
import contextlib
from django.db import transaction
from django.db.models import Sum
from users.models import ProductVariant, Product

DRY_RUN = os.environ.get("APPLY") != "1"


def run():
    keep = ProductVariant.objects.get(id=8716)
    dupe = ProductVariant.objects.get(id=8717)
    print(f"garder id={keep.id} {keep.size!r}/{keep.color!r} qty={keep.quantity}")
    print(f"fusionner id={dupe.id} {dupe.size!r}/{dupe.color!r} qty={dupe.quantity}")
    new_qty = keep.quantity + dupe.quantity
    print(f"nouvelle quantite fusionnee: {new_qty}")
    if not DRY_RUN:
        keep.quantity = new_qty
        keep.save(update_fields=["quantity"])
        dupe.delete()
        p = Product.objects.get(id=741)
        p.initial_quantity = ProductVariant.objects.filter(product=p).aggregate(t=Sum("quantity"))["t"] or 0
        p.save(update_fields=["initial_quantity"])
        print(f"product 741 initial_quantity -> {p.initial_quantity}")


ctx = transaction.atomic() if not DRY_RUN else contextlib.nullcontext()
with ctx:
    run()
