from django.db.models import Q

from .models import MagasinProfile, EmployerProfile, LoginEvent

BLOCKED_MESSAGE = "Abonnement inactif, contactez Label Technology."


def get_client_ip(request):
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR")


def get_subscription_owner(user):
    """Resolve the CustomUser (role=admin) whose AdminProfile.subscription
    governs this user's login, for admin/magasin/employer roles."""
    if not user or not user.is_authenticated:
        return None

    if user.role == "admin":
        magasin = (
            MagasinProfile.objects.filter(Q(admin=user) | Q(admins=user))
            .order_by("created_at")
            .first()
        )
        return magasin.admin if magasin else user

    if user.role == "magasin":
        mp = getattr(user, "magasin_profile", None)
        return mp.admin if mp else None

    if user.role == "employer":
        ep = getattr(user, "employer_profile", None)
        if not ep:
            return None
        if ep.admin:
            return ep.admin
        if ep.magasin:
            return ep.magasin.admin
        return None

    return None


def get_subscription(user):
    owner = get_subscription_owner(user)
    if not owner:
        return None
    try:
        return owner.admin_profile.subscription
    except Exception:
        return None


def is_login_allowed(user):
    if user.role not in ("admin", "magasin", "employer"):
        return True
    sub = get_subscription(user)
    if sub is None:
        return False
    return sub.is_currently_active


def get_company_magasins(admin_user):
    """All MagasinProfile queryset owned or co-managed by admin_user."""
    return MagasinProfile.objects.filter(Q(admin=admin_user) | Q(admins=admin_user)).distinct()


def get_company_user_ids(admin_user):
    """All CustomUser ids belonging to the company owned by admin_user:
    the admin, co-admins, magasin users, and employers under those magasins."""
    ids = {admin_user.id}

    magasins = get_company_magasins(admin_user)
    for mp in magasins:
        ids.update(mp.admins.values_list("id", flat=True))
        if mp.user_id:
            ids.add(mp.user_id)

    magasin_ids = list(magasins.values_list("id", flat=True))
    employer_ids = EmployerProfile.objects.filter(
        Q(admin=admin_user) | Q(magasin_id__in=magasin_ids)
    ).values_list("user_id", flat=True)
    ids.update(employer_ids)

    return ids


def get_company_admin_ids(admin_user):
    """All CustomUser ids (role=admin) managing this company: the primary
    admin plus every co-admin on any of its magasins."""
    ids = {admin_user.id}
    for mp in get_company_magasins(admin_user):
        ids.add(mp.admin_id)
        ids.update(mp.admins.values_list("id", flat=True))
    return ids


def get_company_devices(admin_user, limit=20):
    """Most recent LoginEvent rows for every user of this company."""
    user_ids = get_company_user_ids(admin_user)
    return LoginEvent.objects.filter(user_id__in=user_ids).select_related("user")[:limit]
