from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer


def _get_magasin_and_admin(instance):
    magasin_id = None
    admin_id = None

    magasin = getattr(instance, "magasin", None)
    if magasin is not None:
        magasin_id = magasin.id
        admin_id = magasin.admin_id
    elif getattr(instance, "magasin_id", None):
        magasin_id = instance.magasin_id
        try:
            from users.models import MagasinProfile
            magasin = MagasinProfile.objects.select_related("admin").get(id=magasin_id)
            admin_id = magasin.admin_id
        except Exception:
            pass

    if magasin_id is None and hasattr(instance, "product"):
        product = instance.product
        if product and product.magasin_id:
            magasin_id = product.magasin_id
            try:
                from users.models import MagasinProfile
                magasin = MagasinProfile.objects.select_related("admin").get(id=magasin_id)
                admin_id = magasin.admin_id
            except Exception:
                pass

    return magasin_id, admin_id


def broadcast_data_event(model, action, instance):
    """Broadcast a data sync event to WebSocket groups."""
    try:
        channel_layer = get_channel_layer()
        if not channel_layer:
            return

        magasin_id, admin_id = _get_magasin_and_admin(instance)

        payload = {
            "model": model,
            "action": action,
            "id": getattr(instance, "id", None),
            "magasin_id": magasin_id,
        }

        event = {"type": "data_update", "payload": payload}

        if admin_id:
            async_to_sync(channel_layer.group_send)(f"data_admin_{admin_id}", event)
        if magasin_id:
            async_to_sync(channel_layer.group_send)(f"data_magasin_{magasin_id}", event)
    except Exception as e:
        print(f"Error broadcasting data event ({model}/{action}):", e)
