-- Cache the GitHub avatar as a data: URI so the client never hits GitHub
ALTER TABLE "Package" ADD COLUMN "iconData" TEXT;
