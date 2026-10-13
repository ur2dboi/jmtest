import { NextResponse, type NextRequest } from 'next/server';
import { readSessionToken } from '@/lib/session-token';

const SESSION_COOKIE = 'mj_session';

/**
 * Traffic controller (port of mlm_process_system_forms / template_redirect):
 *  - /member-portal & /admin-dashboard require a session
 *  - legacy WordPress auth URLs are redirected to the member login
 *  - app pages are never cached (DONOTCACHEPAGE)
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === '/wp-login.php' || pathname.startsWith('/wp-admin')) {
    const url = req.nextUrl.clone();
    url.pathname = '/member-login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const session = await readSessionToken(token);

  if (pathname.startsWith('/member-portal') && !session) {
    const url = req.nextUrl.clone();
    url.pathname = '/member-login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (pathname.startsWith('/admin-dashboard') && session?.r === 'member') {
    // Members who wander here still see the gateway form (page handles it),
    // but a member session must never render the command center.
    const res = NextResponse.next();
    res.headers.set('Cache-Control', 'no-store, must-revalidate');
    return res;
  }

  const res = NextResponse.next();
  if (pathname.startsWith('/member-portal') || pathname.startsWith('/admin-dashboard')) {
    res.headers.set('Cache-Control', 'no-store, must-revalidate');
  }
  return res;
}

export const config = {
  matcher: ['/member-portal/:path*', '/admin-dashboard/:path*', '/wp-login.php', '/wp-admin/:path*'],
};
