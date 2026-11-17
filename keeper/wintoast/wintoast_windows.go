//go:build windows

// Package wintoast shows Windows toasts with buttons and a text box from a plain (unpackaged) Go program, and receives their
// clicks through a COM activator: Inbox v3.1 phase 4 (private/designs/inbox-v31, section 3). Pure Go over combase/ole32, no cgo,
// no PowerShell, no console. Every WinRT call runs on one locked OS thread in the multithreaded apartment.
//
// The app's identity is registry-only (registry.go): HKCU\Software\Classes\AppUserModelId\<AUMID> {DisplayName, IconUri,
// CustomActivator} and HKCU\Software\Classes\CLSID\{clsid}\LocalServer32. No Start-menu shortcut property is needed.
package wintoast

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	combase                 = windows.NewLazySystemDLL("combase.dll")
	pRoInitialize           = combase.NewProc("RoInitialize")
	pRoGetActivationFactory = combase.NewProc("RoGetActivationFactory")
	pRoActivateInstance     = combase.NewProc("RoActivateInstance")
	pWindowsCreateString    = combase.NewProc("WindowsCreateString")
	pWindowsDeleteString    = combase.NewProc("WindowsDeleteString")
	ole32                   = windows.NewLazySystemDLL("ole32.dll")
	pCoInitializeEx         = ole32.NewProc("CoInitializeEx")
	pCoRegisterClassObject  = ole32.NewProc("CoRegisterClassObject")
	pCoRevokeClassObject    = ole32.NewProc("CoRevokeClassObject")
)

func guid(s string) windows.GUID {
	g, err := windows.GUIDFromString(s)
	if err != nil {
		panic(err)
	}
	return g
}

var (
	iidIUnknown                        = guid("{00000000-0000-0000-C000-000000000046}")
	iidIClassFactory                   = guid("{00000001-0000-0000-C000-000000000046}")
	iidINotificationActivationCallback = guid("{53E31837-6600-4A81-9395-75CFFE746F94}")
	iidToastManagerStatics             = guid("{50AC103F-D235-4598-BBEF-98FE4D1A3AD4}")
	iidToastManagerStatics2            = guid("{7AB93C52-0E48-4750-BA9D-1A4113981847}")
	iidToastHistory2                   = guid("{3BC3D253-2F31-4092-9129-8AD5ABF067DA}")
	iidToastFactory                    = guid("{04124B20-82C6-4229-B109-FD9ED4662B53}")
	iidToastNotification2              = guid("{9DFB9FD1-143A-490E-90BF-B9FBA7132DE7}")
	iidXmlDocumentIO                   = guid("{6CD0E74E-EE65-4489-9EBF-CA43E87BA637}")
	iidXmlDocument                     = guid("{F7F3A506-1E87-42D6-BCFB-B8C809FA5494}")
)

// HResult is a failed COM/WinRT call's result.
type HResult uint32

func (h HResult) Error() string { return fmt.Sprintf("HRESULT 0x%08X", uint32(h)) }

func check(r uintptr) error {
	if int32(r) < 0 {
		return HResult(uint32(r))
	}
	return nil
}

type hstring uintptr

func newHString(s string) (hstring, error) {
	if s == "" {
		return 0, nil // the null HSTRING is the empty string
	}
	u, err := windows.UTF16FromString(s)
	if err != nil {
		return 0, err
	}
	var h hstring
	r, _, _ := pWindowsCreateString.Call(uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)-1), uintptr(unsafe.Pointer(&h)))
	return h, check(r)
}

func (h hstring) free() {
	if h != 0 {
		pWindowsDeleteString.Call(uintptr(h))
	}
}

// obj is a COM interface pointer.
type obj uintptr

func (o obj) call(slot int, args ...uintptr) error {
	if o == 0 {
		return errors.New("nil COM object")
	}
	vtbl := *(*uintptr)(unsafe.Pointer(uintptr(o)))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(slot)*unsafe.Sizeof(uintptr(0))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(o)}, args...)...)
	return check(r)
}

func (o obj) qi(iid *windows.GUID) (obj, error) {
	var out obj
	err := o.call(0, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out)))
	return out, err
}

func (o obj) release() {
	if o != 0 {
		o.call(2)
	}
}

func factory(class string, iid *windows.GUID) (obj, error) {
	h, err := newHString(class)
	if err != nil {
		return 0, err
	}
	defer h.free()
	var out obj
	r, _, _ := pRoGetActivationFactory.Call(uintptr(h), uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out)))
	return out, check(r)
}

func activate(class string) (obj, error) {
	h, err := newHString(class)
	if err != nil {
		return 0, err
	}
	defer h.free()
	var out obj
	r, _, _ := pRoActivateInstance.Call(uintptr(h), uintptr(unsafe.Pointer(&out)))
	return out, check(r)
}

// Notification settings (Windows.UI.Notifications.NotificationSetting).
const (
	SettingEnabled                = 0
	SettingDisabledForApplication = 1
	SettingDisabledForUser        = 2
	SettingDisabledByGroupPolicy  = 3
	SettingDisabledByManifest     = 4
)

// Toaster shows and removes one app's toasts. All calls run on one locked OS thread.
type Toaster struct {
	appID string
	work  chan func()
	once  sync.Once

	statics, notifier, history obj
}

// NewToaster starts the toast thread for an AUMID.
func NewToaster(appID string) (*Toaster, error) {
	t := &Toaster{appID: appID, work: make(chan func())}
	ready := make(chan error, 1)
	go t.loop(ready)
	if err := <-ready; err != nil {
		return nil, err
	}
	return t, nil
}

func (t *Toaster) loop(ready chan<- error) {
	runtime.LockOSThread()
	r, _, _ := pRoInitialize.Call(1)             // RO_INIT_MULTITHREADED; S_FALSE (already) is fine
	if int32(r) < 0 && uint32(r) != 0x80010106 { // RPC_E_CHANGED_MODE: another init on this thread, still usable
		ready <- fmt.Errorf("RoInitialize: %w", HResult(uint32(r)))
		return
	}
	err := t.setup()
	ready <- err
	if err != nil {
		return
	}
	for fn := range t.work {
		fn()
	}
}

func (t *Toaster) setup() error {
	statics, err := factory("Windows.UI.Notifications.ToastNotificationManager", &iidToastManagerStatics)
	if err != nil {
		return fmt.Errorf("ToastNotificationManager: %w", err)
	}
	t.statics = statics
	id, err := newHString(t.appID)
	if err != nil {
		return err
	}
	defer id.free()
	if err := statics.call(7, uintptr(id), uintptr(unsafe.Pointer(&t.notifier))); err != nil { // CreateToastNotifierWithId
		return fmt.Errorf("CreateToastNotifier: %w", err)
	}
	if s2, err := statics.qi(&iidToastManagerStatics2); err == nil {
		s2.call(6, uintptr(unsafe.Pointer(&t.history))) // get_History; removal is best effort without it
		s2.release()
	}
	return nil
}

func (t *Toaster) do(fn func() error) error {
	done := make(chan error, 1)
	t.work <- func() { done <- fn() }
	return <-done
}

// Setting is Windows' notification setting for this app (SettingEnabled ...).
func (t *Toaster) Setting() (int, error) {
	var v int32
	err := t.do(func() error { return t.notifier.call(8, uintptr(unsafe.Pointer(&v))) }) // get_Setting
	return int(v), err
}

// Show shows one toast. tag/group: a newer toast with the same pair replaces the older. suppress: straight to the notification
// centre, no pop-up on screen (the registry check uses it).
func (t *Toaster) Show(xml, tag, group string, suppress bool) error {
	return t.do(func() error {
		doc, err := activate("Windows.Data.Xml.Dom.XmlDocument")
		if err != nil {
			return fmt.Errorf("XmlDocument: %w", err)
		}
		defer doc.release()
		io, err := doc.qi(&iidXmlDocumentIO)
		if err != nil {
			return err
		}
		defer io.release()
		x, err := newHString(xml)
		if err != nil {
			return err
		}
		defer x.free()
		if err := io.call(6, uintptr(x)); err != nil { // LoadXml
			return fmt.Errorf("toast XML: %w", err)
		}
		xdoc, err := doc.qi(&iidXmlDocument)
		if err != nil {
			return err
		}
		defer xdoc.release()
		fac, err := factory("Windows.UI.Notifications.ToastNotification", &iidToastFactory)
		if err != nil {
			return err
		}
		defer fac.release()
		var toast obj
		if err := fac.call(6, uintptr(xdoc), uintptr(unsafe.Pointer(&toast))); err != nil { // CreateToastNotification
			return err
		}
		defer toast.release()
		if t2, err := toast.qi(&iidToastNotification2); err == nil {
			defer t2.release()
			if tag != "" {
				h, _ := newHString(tag)
				t2.call(6, uintptr(h)) // put_Tag
				h.free()
			}
			if group != "" {
				h, _ := newHString(group)
				t2.call(8, uintptr(h)) // put_Group
				h.free()
			}
			if suppress {
				t2.call(10, 1) // put_SuppressPopup
			}
		}
		return t.notifier.call(6, uintptr(toast)) // Show
	})
}

// Remove takes a toast (tag, group) out of the notification centre.
func (t *Toaster) Remove(tag, group string) error {
	return t.do(func() error {
		if t.history == 0 {
			return errors.New("no toast history")
		}
		h1, _ := newHString(tag)
		h2, _ := newHString(group)
		h3, _ := newHString(t.appID)
		defer h1.free()
		defer h2.free()
		defer h3.free()
		return t.history.call(8, uintptr(h1), uintptr(h2), uintptr(h3)) // RemoveGroupedTagWithId
	})
}

// Clear removes every toast of this app from the notification centre.
func (t *Toaster) Clear() error {
	return t.do(func() error {
		if t.history == 0 {
			return errors.New("no toast history")
		}
		h, _ := newHString(t.appID)
		defer h.free()
		return t.history.call(12, uintptr(h)) // ClearWithId
	})
}

// Count is how many of this app's toasts the notification centre holds.
func (t *Toaster) Count() (int, error) {
	n := uint32(0)
	err := t.do(func() error {
		if t.history == 0 {
			return errors.New("no toast history")
		}
		h2, err := t.history.qi(&iidToastHistory2)
		if err != nil {
			return err
		}
		defer h2.release()
		id, _ := newHString(t.appID)
		defer id.free()
		var view obj
		if err := h2.call(7, uintptr(id), uintptr(unsafe.Pointer(&view))); err != nil { // GetHistoryWithId
			return err
		}
		defer view.release()
		return view.call(7, uintptr(unsafe.Pointer(&n))) // IVectorView.get_Size
	})
	return int(n), err
}

// Close ends the toast thread.
func (t *Toaster) Close() {
	t.once.Do(func() {
		t.do(func() error {
			t.history.release()
			t.notifier.release()
			t.statics.release()
			return nil
		})
		close(t.work)
	})
}

// ---------- the COM activator ----------

// Activation is one click: the button's arguments and what was typed in the toast's text boxes (input id -> text).
type Activation struct {
	AppID  string
	Args   string
	Inputs map[string]string
}

type comObject struct {
	vtbl *[6]uintptr
}

var (
	actMu       sync.Mutex
	actHandler  func(Activation)
	cbOnce      sync.Once
	factoryVt   [6]uintptr
	callbackVt  [6]uintptr
	factoryObj  comObject
	callbackObj comObject
)

func equalGUID(p uintptr, g *windows.GUID) bool {
	return p != 0 && *(*windows.GUID)(unsafe.Pointer(p)) == *g
}

func makeVtables() {
	addRef := syscall.NewCallback(func(this uintptr) uintptr { return 1 })
	release := syscall.NewCallback(func(this uintptr) uintptr { return 1 })
	factoryVt = [6]uintptr{
		syscall.NewCallback(func(this, riid, ppv uintptr) uintptr {
			if equalGUID(riid, &iidIUnknown) || equalGUID(riid, &iidIClassFactory) {
				*(*uintptr)(unsafe.Pointer(ppv)) = this
				return 0
			}
			*(*uintptr)(unsafe.Pointer(ppv)) = 0
			return 0x80004002 // E_NOINTERFACE
		}),
		addRef, release,
		syscall.NewCallback(func(this, outer, riid, ppv uintptr) uintptr { // CreateInstance
			if outer != 0 {
				return 0x80040110 // CLASS_E_NOAGGREGATION
			}
			if equalGUID(riid, &iidIUnknown) || equalGUID(riid, &iidINotificationActivationCallback) {
				*(*uintptr)(unsafe.Pointer(ppv)) = uintptr(unsafe.Pointer(&callbackObj))
				return 0
			}
			*(*uintptr)(unsafe.Pointer(ppv)) = 0
			return 0x80004002
		}),
		syscall.NewCallback(func(this, lock uintptr) uintptr { return 0 }), // LockServer
	}
	callbackVt = [6]uintptr{
		syscall.NewCallback(func(this, riid, ppv uintptr) uintptr {
			if equalGUID(riid, &iidIUnknown) || equalGUID(riid, &iidINotificationActivationCallback) {
				*(*uintptr)(unsafe.Pointer(ppv)) = this
				return 0
			}
			*(*uintptr)(unsafe.Pointer(ppv)) = 0
			return 0x80004002
		}),
		addRef, release,
		syscall.NewCallback(func(this, appID, args, data, count uintptr) uintptr { // Activate
			a := Activation{
				AppID:  windows.UTF16PtrToString((*uint16)(unsafe.Pointer(appID))),
				Args:   windows.UTF16PtrToString((*uint16)(unsafe.Pointer(args))),
				Inputs: map[string]string{},
			}
			type pair struct{ key, value *uint16 }
			for i := uintptr(0); i < count && i < 16; i++ {
				p := (*pair)(unsafe.Pointer(data + i*unsafe.Sizeof(pair{})))
				a.Inputs[windows.UTF16PtrToString(p.key)] = windows.UTF16PtrToString(p.value)
			}
			actMu.Lock()
			h := actHandler
			actMu.Unlock()
			if h != nil {
				go h(a) // never hold Windows' thread
			}
			return 0
		}),
		0, 0,
	}
	factoryObj.vtbl = &factoryVt
	callbackObj.vtbl = &callbackVt
}

// RegisterActivator makes this process the toast click handler for clsid (CoRegisterClassObject, local server, many uses) until
// revoke is called. Windows calls handler for each click on a toast of an AUMID whose CustomActivator is clsid.
func RegisterActivator(clsid string, handler func(Activation)) (revoke func(), err error) {
	g, err := windows.GUIDFromString(clsid)
	if err != nil {
		return nil, err
	}
	cbOnce.Do(makeVtables)
	actMu.Lock()
	actHandler = handler
	actMu.Unlock()
	type result struct {
		cookie uint32
		err    error
	}
	done := make(chan result, 1)
	stop := make(chan struct{})
	go func() {
		runtime.LockOSThread()
		pCoInitializeEx.Call(0, 0) // COINIT_MULTITHREADED
		var cookie uint32
		r, _, _ := pCoRegisterClassObject.Call(uintptr(unsafe.Pointer(&g)), uintptr(unsafe.Pointer(&factoryObj)),
			4 /* CLSCTX_LOCAL_SERVER */, 1 /* REGCLS_MULTIPLEUSE */, uintptr(unsafe.Pointer(&cookie)))
		done <- result{cookie, check(r)}
		if check(r) != nil {
			return
		}
		<-stop
		pCoRevokeClassObject.Call(uintptr(cookie))
	}()
	res := <-done
	if res.err != nil {
		return nil, fmt.Errorf("CoRegisterClassObject: %w", res.err)
	}
	var once sync.Once
	return func() { once.Do(func() { close(stop) }) }, nil
}
