"""In-app update indicator and self-update for git installs.

- ``version``  : semantic versions and the app's own version (root package.json).
- ``settings`` : the release repository, channel and update prefs.
- ``releases`` : the update check against GitHub releases (cached, quiet).
- ``install``  : what kind of install this is and whether it can update itself.
- ``commands`` : running commands as argument lists, with a redacted log.
- ``engine``   : the guarded fast-forward update with rollback.
- ``supervisor``: asking ``app.py`` to pause the frontend or restart.
- ``routes``   : ``/api/app/version`` and ``/api/app/update*``.
"""
