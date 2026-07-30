from rest_framework.permissions import BasePermission


class IsAdmin(BasePermission):

    def has_permission(self, request, view):

        return (
            request.user.is_authenticated
            and request.user.role == "admin"
        )


class IsCompanyOwner(BasePermission):
    """Like IsAdmin, but excludes co-admins added via AddAdminView: only the
    admin who actually owns the company (has an AdminProfile) passes. Used to
    gate company-level actions (adding/removing admins, subscription,
    devices) that co-admins share full data access but no ownership over."""

    def has_permission(self, request, view):
        from .models import AdminProfile

        return (
            request.user.is_authenticated
            and request.user.role == "admin"
            and AdminProfile.objects.filter(user=request.user).exists()
        )


class IsMagasin(BasePermission):

    def has_permission(self, request, view):

        return (
            request.user.is_authenticated
            and request.user.role == "magasin"
        )


class IsEmployer(BasePermission):

    def has_permission(self, request, view):

        return (
            request.user.is_authenticated
            and request.user.role == "employer"
        )


class IsPlatformOwner(BasePermission):

    def has_permission(self, request, view):

        return (
            request.user.is_authenticated
            and request.user.role == "platform_admin"
        )