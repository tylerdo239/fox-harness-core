"""FastAPI dependencies for the reference routes in src/apis/routes (ours, replacing the reference's deps.py).

The reference authenticates with its own JWT cookie. Here the routes run only inside bridge/admin_runner.py,
behind services/gateway's admin gate, so the caller is already known: the gateway sends the admin's email in
the `x-fox-user` header (stored as `reviewed_by` and the like). No cookie, no token, no network listener.
"""

from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

from src.database.mongodb import AttrDatabase, get_mongo_db_dependency
from src.settings import Settings, get_settings

SettingsDep = Annotated[Settings, Depends(get_settings)]


def get_current_user(x_fox_user: Annotated[str | None, Header()] = None) -> str:
    if not x_fox_user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    return x_fox_user


CurrentUserDep = Annotated[str, Depends(get_current_user)]


MongoDep = Annotated[AttrDatabase, Depends(get_mongo_db_dependency)]
